const express = require("express");
const session = require("express-session");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

try {
    fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach((linea) => {
        const m = linea.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
        if (m && !m[0].startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    });
} catch (e) {}

const app = express();
const PUERTO = process.env.PORT || 3000;

// ----------------------------------------------------------------------
// 1. CONFIGURACIÓN
// ----------------------------------------------------------------------
const pool = mysql.createPool({
    host: process.env.DB_HOST || "gateway01.ap-northeast-1.prod.aws.tidbcloud.com",
    port: process.env.DB_PORT || 4000,
    user: process.env.DB_USER || "BTuecY147u3PMJP.root",
    password: process.env.DB_PASS || "pDIXDumSU7V2xl9h",
    database: process.env.DB_NAME || "nutriLunch",
    decimalNumbers: true,   
    dateStrings: true,      
    connectionLimit: 10
});

const ENVIO = 1.0;
const PORCIONES = { "Pequeña": 0.8, "Normal": 1, "Grande": 1.25 };
const ESTADOS = ["Recibido", "Preparando", "En camino", "Entregado", "Cancelado"];
const ROLES = ["cliente", "administrador", "repartidor"];
const CATEGORIAS = ["Desayuno", "Almuerzo", "Cena", "Postres", "Bebidas"];
const CORREO_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TELEFONO_VALIDO = /^[\d+\-\s()]{7,20}$/;
const intentosFallidos = {};   // límite de intentos de login
const mensajesPorIp = {};      // límite de mensajes de contacto

app.use(session({
    secret: process.env.SECRET_KEY || "turcios",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));

// Defensa básica contra CSRF: las escrituras deben enviarse como JSON
app.use("/api", (req, res, next) => {
    const tipo = req.headers["content-type"] || "";
    if (["POST", "PUT", "DELETE"].includes(req.method) && !tipo.startsWith("application/json")) {
        return error(res, 415, "Tipo de contenido no permitido");
    }
    next();
});

const consulta = async (sql, params = []) => (await pool.query(sql, params))[0];
const uno = async (sql, params = []) => (await consulta(sql, params))[0];
const error = (res, codigo, mensaje) => res.status(codigo).json({ error: mensaje });
const redondear = (n) => Math.round(n * 100) / 100;
const texto = (valor, max) => String(valor || "").trim().slice(0, max);

// Captura los errores de MySQL en cada ruta
const ruta = (funcion) => (req, res) =>
    funcion(req, res).catch((e) => {
        console.error(e);
        error(res, 500, "Error de base de datos. Revisa que MySQL esté encendido y la configuración de server.js.");
    });

// Exige sesión iniciada (y opcionalmente uno de los roles indicados)
const necesitaSesion = (...roles) => (req, res, next) => {
    if (!req.session.uid) return error(res, 401, "Inicia sesión.");
    if (roles.length && !roles.includes(req.session.rol)) return error(res, 403, "No tienes permiso.");
    next();
};

function iniciarSesion(req, res, usuario, codigo = 200) {
    req.session.regenerate(() => {
        Object.assign(req.session, { uid: usuario.id, rol: usuario.rol, nombre: usuario.nombre });
        res.status(codigo).json(usuario);
    });
}

async function cambiarEstado(idPedido, estado) {
    await consulta("UPDATE pedido SET estado = ? WHERE id_pedido = ?", [estado, idPedido]);
    const estadoEntrega = ["En camino", "Entregado", "Cancelado"].includes(estado) ? estado : "Pendiente";
    await consulta("UPDATE entrega SET estado = ? WHERE id_pedido = ?", [estadoEntrega, idPedido]);
}

// ----------------------------------------------------------------------
// 3. SITIO WEB (archivos estáticos)
// ----------------------------------------------------------------------
// ----------------------------------------------------------------------
// IMÁGENES DE PRODUCTOS (el administrador las sube desde su galería)
// ----------------------------------------------------------------------
const CARPETA_IMG = path.join(__dirname, "img");

app.get("/api/admin/imagenes", necesitaSesion("administrador"), ruta(async (req, res) => {
    const archivos = (await fs.promises.readdir(CARPETA_IMG)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
    const usos = await consulta("SELECT imagen, COUNT(*) AS usos FROM productos GROUP BY imagen");
    archivos.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    res.json(archivos.map((archivo) => ({ archivo, usos: (usos.find((u) => u.imagen === archivo) || { usos: 0 }).usos })));
}));

// Va ANTES del lector JSON general porque acepta cuerpos más grandes (la imagen viaja en base64)
app.post("/api/admin/imagenes", necesitaSesion("administrador"), express.json({ limit: "6mb" }), ruta(async (req, res) => {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ""));
    if (!m) return error(res, 400, "Elige una imagen JPG, PNG o WebP.");
    const bytes = Buffer.from(m[2], "base64");
    if (bytes.length > 4 * 1024 * 1024) return error(res, 400, "La imagen es muy pesada (máximo 4 MB).");
    const firmas = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46] };
    if (!firmas[m[1]].every((b, i) => bytes[i] === b)) return error(res, 400, "El archivo no es una imagen válida.");
    const nombre = "prod_" + Date.now() + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
    await fs.promises.writeFile(path.join(CARPETA_IMG, nombre), bytes);
    res.status(201).json({ imagen: nombre });
}));

app.use(express.json());

app.delete("/api/admin/imagenes/:archivo", necesitaSesion("administrador"), ruta(async (req, res) => {
    const archivo = req.params.archivo;
    if (!/^prod_\d+\.(jpg|png|webp)$/.test(archivo)) return error(res, 400, "Solo se pueden borrar las imágenes que subiste tú.");
    if ((await uno("SELECT COUNT(*) AS v FROM productos WHERE imagen = ?", [archivo])).v > 0) return error(res, 409, "Esa imagen la usa un producto.");
    await fs.promises.unlink(path.join(CARPETA_IMG, archivo)).catch(() => {});
    res.json({ ok: true });
}));

["css", "js", "img"].forEach((carpeta) =>
    app.use("/" + carpeta, express.static(path.join(__dirname, carpeta))));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ----------------------------------------------------------------------
// 4. REGISTRO, LOGIN Y PERFIL
// ----------------------------------------------------------------------
app.post("/api/registro", ruta(async (req, res) => {
    const nombre = texto(req.body.nombre, 50);
    const correo = texto(req.body.correo, 50).toLowerCase();
    const clave = String(req.body.password || "");
    const telefono = texto(req.body.telefono, 20) || null;

    if (nombre.length < 2) return error(res, 400, "Escribe tu nombre.");
    if (!CORREO_VALIDO.test(correo)) return error(res, 400, "Correo no válido.");
    if (clave.length < 8 || !/[A-Za-z]/.test(clave) || !/\d/.test(clave)) {
        return error(res, 400, "La contraseña debe tener mínimo 8 caracteres, con letras y números.");
    }
    if (telefono && !TELEFONO_VALIDO.test(telefono)) return error(res, 400, "Teléfono no válido (solo números, espacios, + y -).");
    if (await uno("SELECT 1 AS x FROM usuario WHERE correo = ?", [correo])) {
        return error(res, 409, "Ese correo ya tiene cuenta.");
    }

    const [resultado] = await pool.query(
        "INSERT INTO usuario (nombre, correo, contrasenia, telefono, rol) VALUES (?, ?, ?, ?, ?)",
        [nombre, correo, await bcrypt.hash(clave, 10), telefono, "cliente"]
    );
    iniciarSesion(req, res, { id: resultado.insertId, nombre, correo, telefono, rol: "cliente" }, 201);
}));

app.post("/api/login", ruta(async (req, res) => {
    const correo = texto(req.body.correo, 50).toLowerCase();
    const llave = req.ip + "|" + correo;
    const intento = intentosFallidos[llave] || { cantidad: 0, hora: 0 };

    if (intento.cantidad >= 5 && Date.now() - intento.hora < 5 * 60 * 1000) {
        return error(res, 429, "Demasiados intentos. Espera 5 minutos.");
    }

    const u = await uno("SELECT * FROM usuario WHERE correo = ?", [correo]);
    if (!u || !(await bcrypt.compare(String(req.body.password || ""), u.contrasenia))) {
        intentosFallidos[llave] = { cantidad: intento.cantidad + 1, hora: Date.now() };
        return error(res, 401, "Correo o contraseña incorrectos.");
    }

    delete intentosFallidos[llave];
    iniciarSesion(req, res, { id: u.id_usuario, nombre: u.nombre, correo: u.correo, rol: u.rol });
}));

app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get("/api/me", ruta(async (req, res) => {
    if (!req.session.uid) return res.json(null);
    res.json(await uno("SELECT id_usuario AS id, nombre, correo, telefono, rol FROM usuario WHERE id_usuario = ?", [req.session.uid]));
}));

app.put("/api/me", necesitaSesion(), ruta(async (req, res) => {
    const nombre = texto(req.body.nombre, 50);
    if (nombre.length < 2) return error(res, 400, "Escribe tu nombre.");
    const telefono = texto(req.body.telefono, 20) || null;
    if (telefono && !TELEFONO_VALIDO.test(telefono)) return error(res, 400, "Teléfono no válido (solo números, espacios, + y -).");
    await consulta("UPDATE usuario SET nombre = ?, telefono = ? WHERE id_usuario = ?",
        [nombre, telefono, req.session.uid]);
    res.json(await uno("SELECT id_usuario AS id, nombre, correo, telefono, rol FROM usuario WHERE id_usuario = ?", [req.session.uid]));
}));

// ----------------------------------------------------------------------
// 5. ALERGIAS, INTOLERANCIAS Y FAVORITOS (del cliente)
// ----------------------------------------------------------------------
app.put("/api/me/password", necesitaSesion(), ruta(async (req, res) => {
    const actual = String(req.body.actual || "");
    const nueva = String(req.body.nueva || "");
    if (nueva.length < 8 || !/[A-Za-z]/.test(nueva) || !/\d/.test(nueva)) {
        return error(res, 400, "La contraseña nueva debe tener mínimo 8 caracteres, con letras y números.");
    }
    const u = await uno("SELECT contrasenia FROM usuario WHERE id_usuario = ?", [req.session.uid]);
    if (!(await bcrypt.compare(actual, u.contrasenia))) return error(res, 401, "La contraseña actual no es correcta.");
    await consulta("UPDATE usuario SET contrasenia = ? WHERE id_usuario = ?", [await bcrypt.hash(nueva, 10), req.session.uid]);
    res.json({ ok: true });
}));

app.get("/api/restricciones", necesitaSesion(), ruta(async (req, res) => {
    res.json(await consulta("SELECT * FROM restricciones WHERE id_usuario = ? ORDER BY id_restriccion", [req.session.uid]));
}));

app.post("/api/restricciones", necesitaSesion(), ruta(async (req, res) => {
    const tipo = req.body.tipo;
    const descripcion = texto(req.body.descripcion, 50);
    if (!["alergia", "intolerancia", "preferencia"].includes(tipo) || !descripcion) {
        return error(res, 400, "Completa el tipo y la descripción.");
    }
    const [r] = await pool.query("INSERT INTO restricciones (id_usuario, tipo, descripcion) VALUES (?, ?, ?)", [req.session.uid, tipo, descripcion]);
    res.status(201).json({ id: r.insertId });
}));

app.delete("/api/restricciones/:id", necesitaSesion(), ruta(async (req, res) => {
    await consulta("DELETE FROM restricciones WHERE id_restriccion = ? AND id_usuario = ?", [req.params.id, req.session.uid]);
    res.json({ ok: true });
}));

app.get("/api/favoritos", necesitaSesion(), ruta(async (req, res) => {
    const filas = await consulta("SELECT id_producto FROM favorito WHERE id_usuario = ? ORDER BY id_producto", [req.session.uid]);
    res.json(filas.map((f) => f.id_producto));
}));

app.post("/api/favoritos", necesitaSesion(), ruta(async (req, res) => {
    const id = parseInt(req.body.id_producto, 10);
    if (!(id > 0) || !(await uno("SELECT 1 AS x FROM productos WHERE id_producto = ?", [id]))) return error(res, 400, "Producto no válido.");
    await consulta("INSERT IGNORE INTO favorito (id_usuario, id_producto) VALUES (?, ?)", [req.session.uid, id]);
    res.status(201).json({ ok: true });
}));

app.delete("/api/favoritos/:id", necesitaSesion(), ruta(async (req, res) => {
    await consulta("DELETE FROM favorito WHERE id_usuario = ? AND id_producto = ?", [req.session.uid, req.params.id]);
    res.json({ ok: true });
}));

// ----------------------------------------------------------------------
// 6. PRODUCTOS (catálogo público y CRUD del administrador)
// ----------------------------------------------------------------------
app.get("/api/productos", ruta(async (req, res) => {
    res.json(await consulta(`
        SELECT id_producto AS id, categoria AS c, nombre AS n, descripcion AS d,
               precio_base AS p, vegetariano AS v, imagen AS i, color AS k
        FROM productos
        WHERE disponible = 1
        ORDER BY id_producto
    `));
}));

const CAMPOS_PRODUCTO = "nombre = ?, descripcion = ?, precio_base = ?, disponible = ?, categoria = ?, imagen = ?, vegetariano = ?";

function datosProducto(d) {
    const nombre = texto(d.nombre, 50);
    const descripcion = texto(d.descripcion, 150);
    const imagen = texto(d.imagen, 50);
    const precio = redondear(parseFloat(d.precio_base));
    if (!nombre || !descripcion || !CATEGORIAS.includes(d.categoria) || !(precio > 0 && precio < 1000) || !/^[\w.-]+$/.test(imagen) || !fs.existsSync(path.join(CARPETA_IMG, imagen))) {
        return null;
    }
    const disponible = d.disponible === undefined || d.disponible ? 1 : 0;
    return [nombre, descripcion, precio, disponible, d.categoria, imagen, d.vegetariano ? 1 : 0];
}

app.get("/api/admin/productos", necesitaSesion("administrador"), ruta(async (req, res) => {
    const buscar = "%" + texto(req.query.q, 50) + "%";
    const categoria = CATEGORIAS.includes(req.query.cat) ? req.query.cat : null;
    const disp = req.query.disp === "1" || req.query.disp === "0" ? Number(req.query.disp) : null;
    res.json(await consulta(`
        SELECT p.*, COALESCE(v.vendidos, 0) AS vendidos
        FROM productos p
        LEFT JOIN (
            SELECT d.id_producto, SUM(d.cantidad) AS vendidos
            FROM detallepedido d INNER JOIN pedido x ON x.id_pedido = d.id_pedido
            WHERE x.estado <> 'Cancelado'
            GROUP BY d.id_producto
        ) v ON v.id_producto = p.id_producto
        WHERE (p.nombre LIKE ? OR p.descripcion LIKE ?)${categoria ? " AND p.categoria = ?" : ""}${disp !== null ? " AND p.disponible = ?" : ""}
        ORDER BY p.categoria, p.id_producto
    `, [buscar, buscar, ...(categoria ? [categoria] : []), ...(disp !== null ? [disp] : [])]));
}));

app.put("/api/admin/productos/:id/disponible", necesitaSesion("administrador"), ruta(async (req, res) => {
    await consulta("UPDATE productos SET disponible = ? WHERE id_producto = ?", [req.body.disponible ? 1 : 0, req.params.id]);
    res.json({ ok: true });
}));

app.post("/api/admin/productos", necesitaSesion("administrador"), ruta(async (req, res) => {
    const datos = datosProducto(req.body);
    if (!datos) return error(res, 400, "Revisa los datos del producto (nombre, descripción, categoría, precio e imagen).");
    const [r] = await pool.query("INSERT INTO productos SET " + CAMPOS_PRODUCTO, datos);
    res.status(201).json({ id: r.insertId });
}));

app.put("/api/admin/productos/:id", necesitaSesion("administrador"), ruta(async (req, res) => {
    const datos = datosProducto(req.body);
    if (!datos) return error(res, 400, "Revisa los datos del producto.");
    await consulta("UPDATE productos SET " + CAMPOS_PRODUCTO + " WHERE id_producto = ?", [...datos, req.params.id]);
    res.json({ ok: true });
}));

app.delete("/api/admin/productos/:id", necesitaSesion("administrador"), ruta(async (req, res) => {
    await consulta("DELETE FROM productos WHERE id_producto = ?", [req.params.id]);
    res.json({ ok: true });
}));

// ----------------------------------------------------------------------
// 7. PEDIDOS
// ----------------------------------------------------------------------
async function buscarPedidos(donde, params) {
    const pedidos = await consulta(`
        SELECT p.id_pedido, p.fecha_pedido, p.estado, p.metodo_pago, p.costo_envio, p.cupon, p.descuento, p.total,
               u.nombre AS cliente, u.correo AS correo, u.telefono AS telefono, e.direccion, e.fecha, e.hora, e.id_repartidor, r.nombre AS repartidor
        FROM pedido p
        INNER JOIN usuario u ON u.id_usuario = p.id_usuario
        LEFT JOIN entrega e ON e.id_pedido = p.id_pedido
        LEFT JOIN usuario r ON r.id_usuario = e.id_repartidor
        WHERE ${donde}
        ORDER BY p.id_pedido DESC
        LIMIT 200
    `, params);

    if (pedidos.length) {
        const detalles = await consulta(
            "SELECT d.id_pedido, d.nombre_item, d.detalle, d.cantidad, d.porcion, d.subtotal, r.tipo AS restriccion_tipo, r.descripcion AS restriccion FROM detallepedido d LEFT JOIN restricciones r ON r.id_restriccion = d.id_restriccion WHERE d.id_pedido IN (?)",
            [pedidos.map((p) => p.id_pedido)]
        );
        pedidos.forEach((p) => { p.items = detalles.filter((d) => d.id_pedido === p.id_pedido); });
    }
    return pedidos;
}

function fechaLocal(fecha) {
    const dos = (n) => String(n).padStart(2, "0");
    return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
}

app.post("/api/pedidos", necesitaSesion(), ruta(async (req, res) => {
    const { items, metodo_pago, fecha, hora, cupon } = req.body;
    const direccion = texto(req.body.direccion, 150);
    const alergias = texto(req.body.alergias, 50);

    if (!Array.isArray(items) || items.length < 1 || items.length > 40) return error(res, 400, "Tu pedido está vacío.");
    if (direccion.length < 3 || !["En línea", "Contra entrega"].includes(metodo_pago)) {
        return error(res, 400, "Revisa la dirección y el método de pago.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || "") || !/^\d{2}:\d{2}(:\d{2})?$/.test(hora || "")) {
        return error(res, 400, "Fecha u hora no válidas.");
    }

    // Hora límite: antes de las 8:00 p.m. del día anterior
    const ahora = new Date();
    const manana = fechaLocal(new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1));
    if (fecha < manana || (fecha === manana && ahora.getHours() >= 20)) {
        return error(res, 400, "Ya pasó la hora límite (8:00 p.m. del día anterior). Elige otra fecha.");
    }

    // Los precios de los platillos se toman SIEMPRE de la base de datos
    const lineas = [];
    let subtotal = 0;
    for (const it of items) {
        const porcion = it.porcion || "Normal";
        const cantidad = parseInt(it.cantidad, 10);
        if (PORCIONES[porcion] === undefined || !(cantidad >= 1 && cantidad <= 20)) return error(res, 400, "Producto no válido.");

        const producto = Number.isInteger(it.id)
            ? await uno("SELECT nombre, precio_base FROM productos WHERE id_producto = ? AND disponible = 1", [it.id])
            : null;
        const idProducto = producto ? it.id : null;
        const nombre = producto ? producto.nombre : texto(it.nombre, 100) || "Artículo";
        const detalle = producto ? null : texto(it.detalle, 255) || null;   // ingredientes de la lonchera personalizada
        const precio = producto ? producto.precio_base : Math.min(Math.max(Number(it.precio) || 0, 0), 50);

        const sub = redondear(precio * PORCIONES[porcion] * cantidad);
        subtotal += sub;
        lineas.push({ idProducto, nombre, detalle, cantidad, porcion, sub });
    }
    const cuponAplicado = String(cupon || "").toUpperCase() === "NUTRI10" ? "NUTRI10" : null;
    const descuento = cuponAplicado ? redondear(subtotal * 0.1) : 0;
    const total = redondear(subtotal - descuento + ENVIO);

    const con = await pool.getConnection();
    try {
        await con.beginTransaction();
        const [pedido] = await con.query(
            "INSERT INTO pedido (id_usuario, fecha_pedido, estado, metodo_pago, costo_envio, cupon, descuento, total) VALUES (?, NOW(), 'Recibido', ?, ?, ?, ?, ?)",
            [req.session.uid, metodo_pago, ENVIO, cuponAplicado, descuento, total]
        );

        let idRestriccion = null;
        if (alergias) {
            const [existe] = await con.query("SELECT id_restriccion FROM restricciones WHERE id_usuario = ? AND descripcion = ?", [req.session.uid, alergias]);
            idRestriccion = existe.length
                ? existe[0].id_restriccion
                : (await con.query("INSERT INTO restricciones (id_usuario, tipo, descripcion) VALUES (?, 'alergia', ?)", [req.session.uid, alergias]))[0].insertId;
        }

        for (const l of lineas) {
            await con.query(
                "INSERT INTO detallepedido (id_pedido, id_producto, nombre_item, detalle, cantidad, porcion, id_restriccion, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [pedido.insertId, l.idProducto, l.nombre, l.detalle, l.cantidad, l.porcion, idRestriccion, l.sub]
            );
        }
        await con.query(
            "INSERT INTO entrega (id_pedido, id_repartidor, direccion, fecha, hora, estado) VALUES (?, NULL, ?, ?, ?, 'Pendiente')",
            [pedido.insertId, direccion, fecha, hora]
        );
        await con.commit();
        res.status(201).json({ id: pedido.insertId, total, estado: "Recibido" });
    } catch (e) {
        await con.rollback();
        throw e;
    } finally {
        con.release();
    }
}));

app.get("/api/pedidos", necesitaSesion(), ruta(async (req, res) => {
    const esAdmin = req.session.rol === "administrador" && !req.query.mios;
    const donde = ["1 = 1"];
    const params = [];

    if (!esAdmin) { donde.push("p.id_usuario = ?"); params.push(req.session.uid); }
    if (ESTADOS.includes(req.query.estado)) { donde.push("p.estado = ?"); params.push(req.query.estado); }
    if (esAdmin && /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || "")) { donde.push("e.fecha = ?"); params.push(req.query.fecha); }
    if (esAdmin && req.query.sinrep) donde.push("e.id_repartidor IS NULL AND p.estado IN ('Recibido', 'Preparando')");
    if (esAdmin && req.query.atrasadas) donde.push("e.fecha < CURDATE() AND p.estado IN ('Recibido', 'Preparando', 'En camino')");
    if (esAdmin && req.query.alergia) donde.push("EXISTS (SELECT 1 FROM detallepedido x WHERE x.id_pedido = p.id_pedido AND x.id_restriccion IS NOT NULL)");

    const q = texto(req.query.q, 50);
    if (q && esAdmin) {
        donde.push("(u.nombre LIKE ? OR p.id_pedido = ?)");
        params.push("%" + q + "%", /^\d+$/.test(q) ? Number(q) : 0);
    }
    res.json(await buscarPedidos(donde.join(" AND "), params));
}));

app.get("/api/pedidos/:id", necesitaSesion(), ruta(async (req, res) => {
    const esAdmin = req.session.rol === "administrador";
    const pedidos = await buscarPedidos(
        "p.id_pedido = ?" + (esAdmin ? "" : " AND p.id_usuario = ?"),
        esAdmin ? [req.params.id] : [req.params.id, req.session.uid]
    );
    pedidos.length ? res.json(pedidos[0]) : error(res, 404, "Pedido no encontrado.");
}));

app.put("/api/pedidos/:id/cancelar", necesitaSesion(), ruta(async (req, res) => {
    const pedido = await uno("SELECT estado FROM pedido WHERE id_pedido = ? AND id_usuario = ?", [req.params.id, req.session.uid]);
    if (!pedido) return error(res, 404, "Pedido no encontrado.");
    if (pedido.estado !== "Recibido") return error(res, 409, "Solo se puede cancelar un pedido que aún no está en preparación.");
    await cambiarEstado(req.params.id, "Cancelado");
    res.json({ ok: true });
}));

app.put("/api/pedidos/:id", necesitaSesion("administrador"), ruta(async (req, res) => {
    const estado = req.body.estado;
    const repartidor = req.body.id_repartidor || null;
    if (!ESTADOS.includes(estado)) return error(res, 400, "Estado no válido.");
    if (repartidor && !(await uno("SELECT 1 AS x FROM usuario WHERE id_usuario = ? AND rol = 'repartidor'", [repartidor]))) {
        return error(res, 400, "Repartidor no válido.");
    }
    await consulta("UPDATE entrega SET id_repartidor = ? WHERE id_pedido = ?", [repartidor, req.params.id]);
    await cambiarEstado(req.params.id, estado);
    res.json({ ok: true });
}));

// ----------------------------------------------------------------------
// 8. ENTREGAS (repartidor)
// ----------------------------------------------------------------------
app.get("/api/entregas", necesitaSesion("repartidor", "administrador"), ruta(async (req, res) => {
    if (req.session.rol === "repartidor") {
        return res.json(await buscarPedidos("e.id_repartidor = ? AND p.estado <> 'Cancelado'", [req.session.uid]));
    }
    res.json(await buscarPedidos("e.id_repartidor IS NOT NULL AND p.estado NOT IN ('Cancelado', 'Entregado')", []));
}));

app.put("/api/entregas/:id", necesitaSesion("repartidor", "administrador"), ruta(async (req, res) => {
    const estado = req.body.estado;
    if (!["En camino", "Entregado"].includes(estado)) return error(res, 400, "Estado no válido.");
    if (req.session.rol === "repartidor" &&
        !(await uno("SELECT 1 AS x FROM entrega WHERE id_pedido = ? AND id_repartidor = ?", [req.params.id, req.session.uid]))) {
        return error(res, 403, "Esta entrega no es tuya.");
    }
    await cambiarEstado(req.params.id, estado);
    res.json({ ok: true });
}));

// ----------------------------------------------------------------------
// 9. CONTACTO, USUARIOS Y REPORTES
// ----------------------------------------------------------------------
// Mensajes del formulario de contacto: se guardan en la base (los lee el administrador)
app.post("/api/contacto", ruta(async (req, res) => {
    const nombre = texto(req.body.nombre, 50);
    const correo = texto(req.body.correo, 50).toLowerCase();
    const mensaje = texto(req.body.mensaje, 1000);
    if (!nombre || !CORREO_VALIDO.test(correo) || mensaje.length < 5) {
        return error(res, 400, "Completa tu nombre, un correo válido y tu mensaje.");
    }

    const intento = mensajesPorIp[req.ip] || { cantidad: 0, hora: Date.now() };
    if (Date.now() - intento.hora > 10 * 60 * 1000) { intento.cantidad = 0; intento.hora = Date.now(); }
    if (intento.cantidad >= 5) return error(res, 429, "Enviaste muchos mensajes. Intenta de nuevo en unos minutos.");
    mensajesPorIp[req.ip] = { cantidad: intento.cantidad + 1, hora: intento.hora };

    await consulta("INSERT INTO mensaje_contacto (id_usuario, nombre, correo, mensaje) VALUES (?, ?, ?, ?)",
        [req.session.uid || null, nombre, correo, mensaje]);
    res.status(201).json({ ok: true });
}));

app.get("/api/admin/mensajes", necesitaSesion("administrador"), ruta(async (req, res) => {
    res.json(await consulta("SELECT id_mensaje, nombre, correo, mensaje, fecha, leido FROM mensaje_contacto ORDER BY leido, id_mensaje DESC LIMIT 200"));
}));

app.put("/api/admin/mensajes/:id", necesitaSesion("administrador"), ruta(async (req, res) => {
    await consulta("UPDATE mensaje_contacto SET leido = ? WHERE id_mensaje = ?", [req.body.leido ? 1 : 0, req.params.id]);
    res.json({ ok: true });
}));

app.delete("/api/admin/mensajes/:id", necesitaSesion("administrador"), ruta(async (req, res) => {
    await consulta("DELETE FROM mensaje_contacto WHERE id_mensaje = ?", [req.params.id]);
    res.json({ ok: true });
}));

app.get("/api/admin/usuarios", necesitaSesion("administrador"), ruta(async (req, res) => {
    const buscar = "%" + texto(req.query.q, 50) + "%";
    const rol = ROLES.includes(req.query.rol) ? req.query.rol : null;
    res.json(await consulta(
        "SELECT u.id_usuario AS id, u.nombre, u.correo, u.telefono, u.rol, u.fecha_registro, COUNT(p.id_pedido) AS pedidos, COALESCE(SUM(CASE WHEN p.estado <> 'Cancelado' THEN p.total END), 0) AS gastado FROM usuario u LEFT JOIN pedido p ON p.id_usuario = u.id_usuario WHERE (u.nombre LIKE ? OR u.correo LIKE ?)" + (rol ? " AND u.rol = ?" : "") + " GROUP BY u.id_usuario ORDER BY u.id_usuario",
        rol ? [buscar, buscar, rol] : [buscar, buscar]
    ));
}));

app.put("/api/admin/usuarios/:id", necesitaSesion("administrador"), ruta(async (req, res) => {
    const rol = req.body.rol;
    if (!ROLES.includes(rol)) return error(res, 400, "Rol no válido.");
    if (Number(req.params.id) === req.session.uid && rol !== "administrador") {
        return error(res, 409, "No puedes quitarte el rol de administrador.");
    }
    await consulta("UPDATE usuario SET rol = ? WHERE id_usuario = ?", [rol, req.params.id]);
    res.json({ ok: true });
}));

app.get("/api/admin/resumen", necesitaSesion("administrador"), ruta(async (req, res) => {
    const hoy = fechaLocal(new Date());
    const manana = fechaLocal(new Date(Date.now() + 864e5));
    const n = async (sql, params = []) => (await uno(sql, params)).v;
    const porEstado = (e) => n("SELECT COUNT(*) AS v FROM pedido WHERE estado = ?", [e]);
    const entregas = (f) => n("SELECT COUNT(*) AS v FROM pedido p INNER JOIN entrega e ON e.id_pedido = p.id_pedido WHERE e.fecha = ? AND p.estado <> 'Cancelado'", [f]);
    res.json({
        hoy, manana,
        nuevos: await porEstado("Recibido"),
        preparando: await porEstado("Preparando"),
        enCamino: await porEstado("En camino"),
        sinRepartidor: await n("SELECT COUNT(*) AS v FROM pedido p INNER JOIN entrega e ON e.id_pedido = p.id_pedido WHERE e.id_repartidor IS NULL AND p.estado IN ('Recibido', 'Preparando')"),
        conAlergias: await n("SELECT COUNT(DISTINCT p.id_pedido) AS v FROM pedido p INNER JOIN detallepedido d ON d.id_pedido = p.id_pedido WHERE d.id_restriccion IS NOT NULL AND p.estado IN ('Recibido', 'Preparando')"),
        entregasHoy: await entregas(hoy),
        entregasManana: await entregas(manana),
        pedidosHoy: await n("SELECT COUNT(*) AS v FROM pedido WHERE DATE(fecha_pedido) = CURDATE() AND estado <> 'Cancelado'"),
        ventasHoy: await n("SELECT COALESCE(SUM(total), 0) AS v FROM pedido WHERE DATE(fecha_pedido) = CURDATE() AND estado <> 'Cancelado'"),
        mensajesSinLeer: await n("SELECT COUNT(*) AS v FROM mensaje_contacto WHERE leido = 0"),
        atrasadas: await n("SELECT COUNT(*) AS v FROM pedido p INNER JOIN entrega e ON e.id_pedido = p.id_pedido WHERE e.fecha < CURDATE() AND p.estado IN ('Recibido', 'Preparando', 'En camino')"),
        sinAtender: await n("SELECT COUNT(*) AS v FROM pedido WHERE estado = 'Recibido' AND fecha_pedido < NOW() - INTERVAL 2 HOUR"),
        actividad: await consulta(`
            (SELECT 'pedido' AS tipo, CONCAT('Pedido #', p.id_pedido, ' de ', u.nombre) AS texto, p.fecha_pedido AS fecha FROM pedido p INNER JOIN usuario u ON u.id_usuario = p.id_usuario)
            UNION ALL (SELECT 'mensaje', CONCAT('Mensaje de ', nombre), fecha FROM mensaje_contacto)
            UNION ALL (SELECT 'registro', CONCAT('Nuevo usuario: ', nombre), fecha_registro FROM usuario)
            ORDER BY fecha DESC LIMIT 10`),
        agotados: await consulta("SELECT id_producto, nombre FROM productos WHERE disponible = 0 ORDER BY nombre"),
        pendientes: await buscarPedidos("p.estado IN ('Recibido', 'Preparando')", [])
    });
}));

// Historial completo de un usuario (para el panel)
app.get("/api/admin/usuarios/:id/detalle", necesitaSesion("administrador"), ruta(async (req, res) => {
    const u = await uno("SELECT id_usuario AS id, nombre, correo, telefono, rol, fecha_registro FROM usuario WHERE id_usuario = ?", [req.params.id]);
    if (!u) return error(res, 404, "Usuario no encontrado.");
    res.json({
        usuario: u,
        pedidos: await buscarPedidos("p.id_usuario = ?", [u.id]),
        restricciones: await consulta("SELECT tipo, descripcion FROM restricciones WHERE id_usuario = ?", [u.id]),
        favoritos: await consulta("SELECT pr.nombre FROM favorito f INNER JOIN productos pr ON pr.id_producto = f.id_producto WHERE f.id_usuario = ?", [u.id])
    });
}));

// Análisis: horas pico, mejores clientes, productos sin ventas, alergias comunes, repartidores...
app.get("/api/admin/analisis", necesitaSesion("administrador"), ruta(async (req, res) => {
    const dias = [7, 30, 90].includes(Number(req.query.dias)) ? Number(req.query.dias) : 0;
    const periodo = dias ? `AND p.fecha_pedido >= CURDATE() - INTERVAL ${dias - 1} DAY` : "";
    const ventas = `p.estado <> 'Cancelado' ${periodo}`;
    const previo = dias ? await uno(`SELECT COALESCE(SUM(total), 0) AS v FROM pedido p WHERE p.estado <> 'Cancelado' AND p.fecha_pedido >= CURDATE() - INTERVAL ${2 * dias - 1} DAY AND p.fecha_pedido < CURDATE() - INTERVAL ${dias - 1} DAY`) : null;
    res.json({
        ventasActual: (await uno(`SELECT COALESCE(SUM(total), 0) AS v FROM pedido p WHERE ${ventas}`)).v,
        ventasPrevio: previo ? previo.v : null,
        horas: await consulta(`SELECT HOUR(fecha_pedido) AS n, COUNT(*) AS v FROM pedido p WHERE ${ventas} GROUP BY HOUR(fecha_pedido) ORDER BY n`),
        semana: await consulta(`SELECT WEEKDAY(fecha_pedido) AS n, COUNT(*) AS v FROM pedido p WHERE ${ventas} GROUP BY WEEKDAY(fecha_pedido) ORDER BY n`),
        clientes: await consulta(`SELECT u.nombre AS n, SUM(p.total) AS v FROM pedido p INNER JOIN usuario u ON u.id_usuario = p.id_usuario WHERE ${ventas} GROUP BY u.id_usuario, u.nombre ORDER BY v DESC LIMIT 5`),
        recurrentes: await uno(`SELECT COALESCE(SUM(c.pedidos = 1), 0) AS nuevos, COALESCE(SUM(c.pedidos > 1), 0) AS recurrentes FROM (SELECT p.id_usuario, COUNT(*) AS pedidos FROM pedido p WHERE ${ventas} GROUP BY p.id_usuario) c`),
        sinVentas: await consulta(`SELECT pr.nombre AS n FROM productos pr WHERE pr.disponible = 1 AND NOT EXISTS (SELECT 1 FROM detallepedido d INNER JOIN pedido p ON p.id_pedido = d.id_pedido WHERE d.id_producto = pr.id_producto AND ${ventas}) ORDER BY pr.nombre`),
        favoritos: await consulta("SELECT pr.nombre AS n, COUNT(*) AS v FROM favorito f INNER JOIN productos pr ON pr.id_producto = f.id_producto GROUP BY pr.id_producto, pr.nombre ORDER BY v DESC LIMIT 5"),
        alergias: await consulta("SELECT LOWER(descripcion) AS n, COUNT(*) AS v FROM restricciones GROUP BY LOWER(descripcion) ORDER BY v DESC LIMIT 6"),
        repartidores: await consulta(`SELECT u.nombre AS n, COALESCE(SUM(p.estado = 'Entregado'), 0) AS entregadas, COALESCE(SUM(p.estado IN ('Recibido', 'Preparando', 'En camino')), 0) AS activas FROM usuario u LEFT JOIN entrega e ON e.id_repartidor = u.id_usuario LEFT JOIN pedido p ON p.id_pedido = e.id_pedido WHERE u.rol = 'repartidor' GROUP BY u.id_usuario, u.nombre ORDER BY entregadas DESC`)
    });
}));

app.get("/api/admin/reportes", necesitaSesion("administrador"), ruta(async (req, res) => {
    const dias = [7, 30, 90].includes(Number(req.query.dias)) ? Number(req.query.dias) : 0;   // 0 = todo el tiempo
    const periodo = dias ? `AND p.fecha_pedido >= CURDATE() - INTERVAL ${dias - 1} DAY` : "";
    const ventas = `p.estado <> 'Cancelado' ${periodo}`;   // los pedidos cancelados no cuentan como ventas
    res.json({
        kpi: await uno(`SELECT COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS ventas, COALESCE(AVG(total), 0) AS ticket, COALESCE(SUM(descuento), 0) AS descuentos FROM pedido p WHERE ${ventas}`),
        cancelados: (await uno(`SELECT COUNT(*) AS v FROM pedido p WHERE p.estado = 'Cancelado' ${periodo}`)).v,
        usuarios: (await uno("SELECT COUNT(*) AS v FROM usuario")).v,
        estados: await consulta(`SELECT estado AS n, COUNT(*) AS v FROM pedido p WHERE 1 = 1 ${periodo} GROUP BY estado`),
        top: await consulta(`
            SELECT d.nombre_item AS n, SUM(d.cantidad) AS v
            FROM detallepedido d INNER JOIN pedido p ON p.id_pedido = d.id_pedido
            WHERE ${ventas}
            GROUP BY d.nombre_item ORDER BY v DESC LIMIT 5`),
        dias: await consulta(`
            SELECT DATE(fecha_pedido) AS n, SUM(total) AS v
            FROM pedido p
            WHERE p.estado <> 'Cancelado' AND fecha_pedido >= CURDATE() - INTERVAL ${(dias || 7) - 1} DAY
            GROUP BY DATE(fecha_pedido) ORDER BY n`),
        cats: await consulta(`
            SELECT COALESCE(pr.categoria, 'Otros') AS n, SUM(d.subtotal) AS v
            FROM detallepedido d
            INNER JOIN pedido p ON p.id_pedido = d.id_pedido
            LEFT JOIN productos pr ON pr.id_producto = d.id_producto
            WHERE ${ventas}
            GROUP BY n ORDER BY v DESC`),
        metodos: await consulta(`SELECT metodo_pago AS n, COUNT(*) AS v FROM pedido p WHERE ${ventas} GROUP BY metodo_pago`),
        lugares: await consulta(`
            SELECT SUBSTRING_INDEX(e.direccion, ':', 1) AS n, COUNT(*) AS v
            FROM pedido p INNER JOIN entrega e ON e.id_pedido = p.id_pedido
            WHERE ${ventas}
            GROUP BY n ORDER BY v DESC`)
    });
}));

// ----------------------------------------------------------------------
// 10. ERRORES Y ARRANQUE
// ----------------------------------------------------------------------
app.use("/api", (req, res) => error(res, 404, "Ruta no encontrada"));
app.use((err, req, res, next) => error(res, 400, "Solicitud no válida."));

// Deja la base lista aunque se haya creado con una versión anterior de schema.sql
async function prepararBase() {
    await consulta(`CREATE TABLE IF NOT EXISTS favorito(
        id_usuario INT NOT NULL,
        id_producto INT NOT NULL,
        PRIMARY KEY (id_usuario, id_producto),
        FOREIGN KEY (id_usuario) REFERENCES usuario(id_usuario) ON DELETE CASCADE,
        FOREIGN KEY (id_producto) REFERENCES productos(id_producto) ON DELETE CASCADE
    )`);
    await consulta(`CREATE TABLE IF NOT EXISTS mensaje_contacto(
        id_mensaje INT PRIMARY KEY AUTO_INCREMENT,
        id_usuario INT NULL,
        nombre VARCHAR(50) NOT NULL,
        correo VARCHAR(50) NOT NULL,
        mensaje VARCHAR(1000) NOT NULL,
        fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        leido BOOLEAN NOT NULL DEFAULT FALSE,
        FOREIGN KEY (id_usuario) REFERENCES usuario(id_usuario) ON DELETE SET NULL
    )`);

    const columnas = [
        ["detallepedido", "detalle", "VARCHAR(255) NULL"],
        ["pedido", "cupon", "VARCHAR(20) NULL"],
        ["pedido", "descuento", "DECIMAL(10,2) NOT NULL DEFAULT 0"],
        ["usuario", "fecha_registro", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"]
    ];
    for (const [tabla, columna, definicion] of columnas) {
        const existe = await uno(
            "SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
            [tabla, columna]
        );
        if (!existe) await consulta(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
    }
}

async function crearAdministrador() {
    try {
        await prepararBase();
        if (await uno("SELECT 1 AS x FROM usuario WHERE rol = 'administrador' LIMIT 1")) return;
        const correo = process.env.ADMIN_EMAIL || "admin@nutrilunch.com";
        const clave = process.env.ADMIN_PASS || "Admin12345";
        await consulta("INSERT INTO usuario (nombre, correo, contrasenia, rol) VALUES ('Administrador', ?, ?, 'administrador')", [correo, await bcrypt.hash(clave, 10)]);
        console.log(`Administrador creado: ${correo} / ${clave}  (cambia la contraseña cuando puedas)`);
    } catch (e) {
        console.error("No se pudo conectar con MySQL (revisa DB_PASS en el archivo .env y que la base nutriLunch exista):", e.message);
    }
}

app.listen(PUERTO, "0.0.0.0", () => {
    console.log(`Servidor corriendo en http://localhost:${PUERTO}`);
    crearAdministrador();
});
