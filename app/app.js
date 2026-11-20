import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/+esm";
import { CONFIG } from "../config.js";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const API = CONFIG.API_URL;
const API_LISTA = API && !API.startsWith("PENDIENTE");
const $ = (id) => document.getElementById(id);

const NIVELES = [
  { id: "facil", nombre: "Fácil" }, { id: "medio", nombre: "Medio" },
  { id: "dificil", nombre: "Difícil" }, { id: "complejo", nombre: "Muy complejo" },
];
const NOMBRE_NIVEL = Object.fromEntries(NIVELES.map((n) => [n.id, n.nombre]));
// Voces de Google (mismo nombre en Chirp HD y Gemini). Al usuario se le muestra género y tipo de voz.
const VOCES = [
  { id: "Kore", genero: "Femenina", tipo: "firme y segura" },
  { id: "Aoede", genero: "Femenina", tipo: "ligera y relajada" },
  { id: "Leda", genero: "Femenina", tipo: "juvenil" },
  { id: "Zephyr", genero: "Femenina", tipo: "brillante y clara" },
  { id: "Puck", genero: "Masculina", tipo: "alegre y animada" },
  { id: "Charon", genero: "Masculina", tipo: "informativa (narrador)" },
  { id: "Fenrir", genero: "Masculina", tipo: "enérgica y emocionada" },
  { id: "Orus", genero: "Masculina", tipo: "firme y seria" },
];
const RX_YT = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{6,}[^\s]*/i;
const MAX_BYTES = 50 * 1024 * 1024;

let usuario = null;
let estado = null;
let nivel = "facil";                       // cada conversación nueva empieza en Fácil
let convActual = null;
let conversaciones = [];
let adjuntos = [];          // {clave, nombre, mime, bytes, ruta, subiendo}
let ocupado = false;
let control = null;
let modoCrear = false;

/* ───────── utilidades ───────── */
function leer(k) { try { return localStorage.getItem(k); } catch { return null; } }
function guardar(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }
function el(tag, attrs = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const h of hijos.flat()) if (h != null) n.append(h.nodeType ? h : document.createTextNode(String(h)));
  return n;
}
const fmt = (n) => Math.round(n).toLocaleString("es-CO");
const tam = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
function estimarTokens(t) {
  const palabras = (t.trim().match(/\S+/g) || []).length;
  return { palabras, tokens: Math.max(Math.ceil(palabras * 1.4), Math.ceil(t.length / 3.6)) };
}
function seguro(nombre) { return nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\-]+/g, "_").slice(-90) || "archivo"; }
function mimeDe(f) {
  if (f.type) return f.type;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  return ({ md: "text/markdown", py: "text/x-python", ts: "text/plain", csv: "text/csv", zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime" })[ext] || "application/octet-stream";
}
const esPro = () => !!estado?.limites?.herramientas;

/* ───────── Markdown + fórmulas (seguro con DOMPurify) ───────── */
marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook("afterSanitizeAttributes", (n) => { if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); } });
let katex = null, cargandoKatex = null;
function cargarKatex() {
  if (katex || cargandoKatex) return cargandoKatex;
  document.head.append(el("link", { rel: "stylesheet", href: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" }));
  cargandoKatex = import("https://cdn.jsdelivr.net/npm/katex@0.16.11/+esm").then((m) => { katex = m.default; });
  return cargandoKatex;
}
function renderMd(nodo, texto) {
  const formulas = [];
  const guardarF = (tex, bloque) => { formulas.push({ tex, bloque }); return `@@F${formulas.length - 1}@@`; };
  let t = texto
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => guardarF(x, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => guardarF(x, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => guardarF(x, false))
    .replace(/\$(?!\s)([^$\n]*?[\\^_=+{][^$\n]*?)(?<!\s)\$/g, (_, x) => guardarF(x, false));
  let html = DOMPurify.sanitize(marked.parse(t));
  if (formulas.length) {
    if (!katex) cargarKatex()?.then(() => renderMd(nodo, texto));
    html = html.replace(/@@F(\d+)@@/g, (_, i) => {
      const f = formulas[+i];
      if (!katex) return DOMPurify.sanitize(`<code>${f.tex.replace(/</g, "&lt;")}</code>`);
      try { return katex.renderToString(f.tex, { displayMode: f.bloque, throwOnError: false, output: "html" }); }
      catch { return `<code>${f.tex.replace(/</g, "&lt;")}</code>`; }
    });
  }
  nodo.innerHTML = html;
  nodo.querySelectorAll("pre").forEach((pre) => {
    const b = el("button", { class: "copiar", type: "button" }, "Copiar");
    b.onclick = () => { navigator.clipboard?.writeText(pre.querySelector("code")?.innerText || pre.innerText); b.textContent = "¡Copiado!"; setTimeout(() => (b.textContent = "Copiar"), 1400); };
    pre.append(b);
  });
}

/* ───────── Acceso ───────── */
function mostrarAcceso() { $("acceso").hidden = false; $("app").hidden = true; }
function avisoAcceso(t) { $("aviso-acceso").textContent = t; }
function cambiarModo(crear) {
  modoCrear = crear;
  $("tab-crear").classList.toggle("activa", crear); $("tab-entrar").classList.toggle("activa", !crear);
  $("tab-crear").setAttribute("aria-selected", crear); $("tab-entrar").setAttribute("aria-selected", !crear);
  $("campo-nombre").hidden = !crear;
  $("btn-acceso").textContent = crear ? "Crear cuenta" : "Ingresar";
  $("clave").autocomplete = crear ? "new-password" : "current-password";
  avisoAcceso("");
}
$("tab-entrar").onclick = () => cambiarModo(false);
$("tab-crear").onclick = () => cambiarModo(true);
$("form-acceso").onsubmit = async (e) => {
  e.preventDefault();
  const correo = $("correo").value.trim(), clave = $("clave").value;
  if (!correo || clave.length < 8) return avisoAcceso("Escribe tu correo y una contraseña de al menos 8 caracteres.");
  $("btn-acceso").disabled = true;
  try {
    const r = modoCrear
      ? await sb.auth.signUp({ email: correo, password: clave, options: { data: { full_name: $("nombre").value.trim() }, emailRedirectTo: location.href.split("#")[0] } })
      : await sb.auth.signInWithPassword({ email: correo, password: clave });
    if (r.error) throw r.error;
    if (modoCrear && !r.data.session) avisoAcceso("Revisa tu correo para confirmar la cuenta.");
  } catch (err) {
    const m = String(err.message || err);
    avisoAcceso(/Invalid login/i.test(m) ? "Correo o contraseña incorrectos." : /already registered/i.test(m) ? "Ese correo ya tiene cuenta. Ingresa." : m);
  } finally { $("btn-acceso").disabled = false; }
};
$("btn-olvide").onclick = async () => {
  const correo = $("correo").value.trim();
  if (!correo) return avisoAcceso("Escribe tu correo y vuelve a pulsar aquí.");
  const { error } = await sb.auth.resetPasswordForEmail(correo, { redirectTo: location.href.split("#")[0] });
  avisoAcceso(error ? error.message : "Te enviamos un enlace para crear una contraseña nueva.");
};
$("form-clave").onsubmit = async (e) => {
  const v = $("clave-nueva").value;
  if (v.length < 8) { e.preventDefault(); return; }
  const { error } = await sb.auth.updateUser({ password: v });
  alert(error ? error.message : "Contraseña actualizada.");
};
$("btn-salir").onclick = () => sb.auth.signOut();

sb.auth.onAuthStateChange((evento, sesion) => {
  if (evento === "PASSWORD_RECOVERY") $("dlg-clave").showModal();
  if (sesion?.user) { if (!usuario || usuario.id !== sesion.user.id) { usuario = sesion.user; iniciarApp(); } }
  else { usuario = null; mostrarAcceso(); }
});

/* ───────── App ───────── */
async function token() { return (await sb.auth.getSession()).data.session?.access_token; }

async function cargarEstado() {
  const { data, error } = await sb.rpc("mi_estado");
  if (!error && data) estado = data;
  pintarNiveles(); pintarCupos();
  $("u-correo").textContent = estado?.nombre || usuario.email;
  const plan = estado?.plan || "gratis";
  $("u-plan").textContent = plan === "pro" ? "Pro" : "Gratis";
  $("u-plan").className = "insignia " + plan;
  $("lnk-admin").hidden = estado?.rol !== "admin";
  $("btn-adjuntar").disabled = !esPro();
  pintarAtajos(); contar();
}

async function iniciarApp() {
  $("acceso").hidden = true; $("app").hidden = false;
  if (!API_LISTA) { $("aviso-api").hidden = false; $("aviso-api").textContent = "Simbi está terminando de instalarse en el servidor. Puedes explorar, pero el chat se activará muy pronto."; }
  else fetch(API + "/salud", { signal: AbortSignal.timeout(8000) }).then((r) => { if (!r.ok) throw 0; })
    .catch(() => { $("aviso-api").hidden = false; $("aviso-api").textContent = "No pude conectar con el servidor de Simbi. Si el problema sigue, intenta en unos minutos."; });
  await cargarEstado();
  await cargarConversaciones();
  const ultima = leer("simb_conv_" + usuario.id);
  if (ultima && conversaciones.some((c) => c.id === ultima)) abrirConversacion(ultima); else nuevaConversacion();
}

function pintarNiveles() {
  const cont = $("niveles"); cont.textContent = "";
  const permitidos = estado?.limites?.niveles || ["facil"];
  if (!permitidos.includes(nivel)) nivel = permitidos[permitidos.length - 1];
  for (const n of NIVELES) {
    const ok = permitidos.includes(n.id);
    cont.append(el("button", { type: "button", role: "radio", "aria-checked": String(n.id === nivel), disabled: !ok,
      title: ok ? "" : "Disponible en la versión Pro",
      onclick: () => { nivel = n.id; pintarNiveles(); } }, ok ? n.nombre : "🔒 " + n.nombre));
  }
}

function pintarCupos() {
  const c = $("cupos"); c.textContent = "";
  if (!estado) return;
  const L = estado.limites, U = estado.usado;
  const filas = [
    ["Tokens de chat", U.chat_tokens, L.chat_tokens, fmt],
    ["Imágenes", U.imagenes, L.imagenes, fmt],
    ["Videos (3 s)", U.videos, L.videos, fmt],
    ["Voz Chirp", U.tts_chirp_seg / 60, L.tts_chirp_seg / 60, (x) => `${x.toFixed(0)} min`],
    ["Voz Gemini", U.tts_gemini_seg / 60, L.tts_gemini_seg / 60, (x) => `${x.toFixed(0)} min`],
    ["Transcripción", U.stt_seg / 60, (L.stt_seg || 0) / 60, (x) => `${x.toFixed(0)} min`],
  ];
  for (const [nom, u, l, f] of filas) {
    if (!l) continue;
    const p = Math.min(100, (u / l) * 100);
    c.append(el("div", { class: "cupo" + (p >= 100 ? " lleno" : p >= 80 ? " alto" : "") },
      el("div", { class: "fila" }, el("span", {}, nom), el("b", {}, `${f(u)} / ${f(l)}`)),
      el("div", { class: "barra-c" }, el("i", { style: `width:${p}%` }))));
  }
  if (estado.reinicia && !estado.prueba_termina) c.append(el("div", { class: "reinicio" }, "Se reinicia el " + new Date(estado.reinicia).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "short" })));
  const pct = L.chat_tokens ? Math.min(100, Math.round((U.chat_tokens / L.chat_tokens) * 100)) : 0;
  $("limite-resumen").textContent = `${pct}%`;
  pintarPrueba();
}

/* Día de prueba (plan gratis) */
const finPrueba = () => (estado?.prueba_termina ? new Date(estado.prueba_termina) : null);
const pruebaVencida = () => { const f = finPrueba(); return !!f && f <= new Date(); };
function textoPrueba() {
  const f = finPrueba(); if (!f) return "";
  const ms = f - new Date();
  if (ms <= 0) return "Tu día de prueba terminó. Pide la versión Pro para seguir usando Simbi.";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `Día de prueba: te quedan ${h ? h + " h " : ""}${m} min`;
}
function pintarPrueba() {
  const t = textoPrueba(), caja = $("prueba"), nota = $("limites-prueba");
  caja.hidden = nota.hidden = !t;
  caja.textContent = nota.textContent = t;
  caja.classList.toggle("vencida", pruebaVencida());
  const env = $("btn-enviar"); if (env) env.disabled = pruebaVencida();
}
setInterval(() => { if (estado?.prueba_termina) pintarPrueba(); }, 30000);
$("btn-limites").onclick = () => { pintarCupos(); $("dlg-limites").showModal(); };

/* ───────── Mis archivos (todo lo que Simbi generó) ───────── */
const TIPOS_ARCH = [
  { id: "todos", nombre: "Todos", es: () => true },
  { id: "img", nombre: "🖼️ Imágenes", es: (m) => m.startsWith("image/") },
  { id: "vid", nombre: "🎬 Videos", es: (m) => m.startsWith("video/") },
  { id: "aud", nombre: "🔊 Audios", es: (m) => m.startsWith("audio/") },
  { id: "doc", nombre: "📄 Documentos", es: (m) => /pdf|word|document|presentation|text\/(plain|markdown|html)/.test(m) },
  { id: "hoja", nombre: "📊 Hojas de cálculo", es: (m) => /sheet|excel|csv/.test(m) },
  { id: "otro", nombre: "📁 Otros", es: (m) => !TIPOS_ARCH.slice(1, 6).some((t) => t.es(m)) },
];
const POR_PAGINA = 48;
let galeria = { lista: [], filtro: "todos", mostrados: POR_PAGINA };

function iconoArch(m) {
  return /sheet|excel|csv/.test(m) ? "📊" : /word|document/.test(m) ? "📄" : /pdf/.test(m) ? "📕" : /presentation/.test(m) ? "📽️"
    : /zip/.test(m) ? "🗜️" : m.startsWith("audio/") ? "🔊" : /text/.test(m) ? "📝" : "📁";
}

async function abrirArchivos() {
  $("dlg-archivos").showModal();
  const g = $("galeria"); g.textContent = ""; g.append(el("div", { class: "vacio" }, "Cargando…"));
  const { data, error } = await sb.from("mensajes").select("id,conversacion_id,adjuntos,creado")
    .eq("rol", "asistente").neq("adjuntos", "[]").order("id", { ascending: false }).limit(400);
  if (error) { g.textContent = ""; g.append(el("div", { class: "vacio" }, "No se pudieron cargar tus archivos.")); return; }
  const titulos = new Map(conversaciones.map((c) => [c.id, c.titulo]));
  galeria.lista = (data || []).flatMap((m) => (m.adjuntos || []).filter((a) => a.ruta && a.origen !== "subido")
    .map((a) => ({ ...a, mime: a.mime || "", creado: m.creado, conv: m.conversacion_id, titulo: titulos.get(m.conversacion_id) || "Conversación" })));
  galeria.mostrados = POR_PAGINA;
  pintarGaleria();
}

function pintarGaleria() {
  const f = $("filtros-arch"); f.textContent = "";
  for (const t of TIPOS_ARCH) {
    const n = galeria.lista.filter((a) => t.es(a.mime)).length;
    if (t.id !== "todos" && !n) continue;
    f.append(el("button", { type: "button", role: "tab", "aria-selected": String(galeria.filtro === t.id),
      onclick: () => { galeria.filtro = t.id; galeria.mostrados = POR_PAGINA; pintarGaleria(); } }, t.nombre, el("small", {}, String(n))));
  }
  const tipo = TIPOS_ARCH.find((t) => t.id === galeria.filtro) || TIPOS_ARCH[0];
  const lista = galeria.lista.filter((a) => tipo.es(a.mime));
  const g = $("galeria"); g.textContent = "";
  if (!lista.length) { g.append(el("div", { class: "vacio" }, "Aún no hay archivos generados aquí. Pídele a Simbi una imagen, un Excel, un PDF o un audio.")); }
  const visibles = lista.slice(0, galeria.mostrados);
  $("mas-archivos").hidden = lista.length <= visibles.length;
  if (!visibles.length) return;
  const tarjetas = visibles.map((a) => {
    const vista = el("div", { class: "vista" }, iconoArch(a.mime));
    const acc = el("div", { class: "acc" });
    const fecha = new Date(a.creado).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
    const t = el("div", { class: "item-arch" }, vista, el("div", { class: "info" }, el("b", { title: a.nombre }, a.nombre),
      el("small", { title: a.titulo }, `${fecha} · ${tam(a.bytes || 0)}`), el("small", {}, a.titulo), acc));
    return { a, vista, acc, t };
  });
  g.append(...tarjetas.map((x) => x.t));
  sb.storage.from("archivos").createSignedUrls(visibles.map((a) => a.ruta), 3600).then(({ data }) => {
    tarjetas.forEach(({ a, vista, acc }, i) => {
      const url = data?.[i]?.signedUrl;
      if (!url) { vista.textContent = "⚠️"; acc.append(el("small", {}, "Ya no está disponible")); return; }
      const urlBajar = url + (url.includes("?") ? "&" : "?") + "download=" + encodeURIComponent(a.nombre);
      if (a.mime.startsWith("image/")) {
        vista.textContent = ""; vista.append(el("img", { src: url, alt: a.nombre, loading: "lazy" }));
        vista.onclick = () => { const v = el("div", { class: "visor", onclick: () => v.remove() }, el("img", { src: url, alt: a.nombre })); document.body.append(v); };
      } else if (a.mime.startsWith("video/")) {
        vista.textContent = ""; vista.append(el("video", { src: url, controls: true, playsinline: true, preload: "metadata" }));
      } else if (a.mime.startsWith("audio/")) {
        vista.textContent = ""; vista.append(el("audio", { src: url, controls: true, preload: "none" }));
      } else {
        vista.onclick = () => window.open(url, "_blank", "noopener");
      }
      acc.append(el("a", { href: urlBajar, download: a.nombre }, "⬇ Descargar"),
        el("button", { type: "button", onclick: () => { $("dlg-archivos").close(); abrirConversacion(a.conv); } }, "Ver chat"));
    });
  });
}
$("btn-archivos").onclick = abrirArchivos;
$("mas-archivos").onclick = () => { galeria.mostrados += POR_PAGINA; pintarGaleria(); };

/* ───────── Conversaciones ───────── */
async function cargarConversaciones() {
  const { data } = await sb.from("conversaciones").select("id,titulo,actualizado,nivel").order("actualizado", { ascending: false }).limit(200);
  conversaciones = data || [];
  pintarLista();
}
function grupoFecha(iso) {
  const d = new Date(iso), hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dias = (hoy - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5;
  return dias <= 0 ? "Hoy" : dias <= 1 ? "Ayer" : dias <= 7 ? "Últimos 7 días" : dias <= 30 ? "Últimos 30 días" : "Antes";
}
function pintarLista() {
  const ul = $("lista-conv"); ul.textContent = "";
  const q = $("buscar").value.trim().toLowerCase();
  let grupo = "";
  for (const c of conversaciones.filter((c) => !q || c.titulo.toLowerCase().includes(q))) {
    const g = grupoFecha(c.actualizado);
    if (g !== grupo) { grupo = g; ul.append(el("div", { class: "fecha" }, g)); }
    ul.append(el("li", { class: c.id === convActual ? "activa" : "" },
      el("button", { class: "ir", type: "button", title: c.titulo, onclick: () => abrirConversacion(c.id) }, c.titulo),
      el("button", { class: "mas", type: "button", "aria-label": "Opciones", onclick: (e) => opcionesConv(e, c) }, "⋯")));
  }
}
$("buscar").oninput = pintarLista;

async function opcionesConv(e, c) {
  e.stopPropagation();
  const accion = prompt(`"${c.titulo}"\n\nEscribe un nombre nuevo para renombrarla,\no escribe BORRAR para eliminarla:`);
  if (!accion) return;
  if (accion.trim().toUpperCase() === "BORRAR") {
    await sb.from("conversaciones").delete().eq("id", c.id);
    conversaciones = conversaciones.filter((x) => x.id !== c.id);
    if (convActual === c.id) nuevaConversacion();
  } else {
    const titulo = accion.trim().slice(0, 80);
    await sb.from("conversaciones").update({ titulo }).eq("id", c.id);
    c.titulo = titulo; if (convActual === c.id) $("titulo-conv").textContent = titulo;
  }
  pintarLista();
}

function nuevaConversacion() {
  convActual = null; guardar("simb_conv_" + usuario.id, "");
  nivel = "facil"; pintarNiveles();
  $("titulo-conv").textContent = "Nueva conversación";
  $("mensajes").textContent = ""; $("mensajes").append(bienvenida);
  pintarLista(); cerrarLateral(); $("texto").focus();
}
$("btn-nuevo").onclick = nuevaConversacion;

async function abrirConversacion(id) {
  if (ocupado) return;
  convActual = id; guardar("simb_conv_" + usuario.id, id);
  const c = conversaciones.find((x) => x.id === id);
  $("titulo-conv").textContent = c?.titulo || "Conversación";
  pintarLista(); cerrarLateral();
  const cont = $("mensajes"); cont.textContent = "";
  cont.append(el("div", { class: "pensando" }, el("i"), el("i"), el("i")));
  const [{ data }, modelos] = await Promise.all([
    sb.from("mensajes").select("id,rol,contenido,adjuntos,eventos,nivel,tokens").eq("conversacion_id", id).order("id").limit(500),
    estado?.rol === "admin" ? sb.rpc("admin_modelos", { p_conv: id }).then((r) => new Map((r.data || []).map((x) => [x.mensaje_id, x]))) : null,
  ]);
  if (convActual !== id) return;
  cont.textContent = "";
  for (const m of data || []) {
    if (m.rol === "usuario") pintarUsuario(m.contenido, m.adjuntos);
    else {
      const v = nuevaRespuesta();
      for (const ev of m.eventos || []) v.evento({ ...ev, t: "herramienta" });
      for (const a of m.adjuntos || []) v.archivo(a);
      v.texto = m.contenido; v.pintar(true);
      v.pie(m.nivel, m.tokens, modelos?.get(m.id));
    }
  }
  cont.scrollTop = cont.scrollHeight;
}

/* ───────── Mensajes ───────── */
const bienvenida = $("bienvenida");
function pintarUsuario(texto, adj = []) {
  const cont = $("mensajes"); bienvenida.remove();
  const cuerpo = el("div", { class: "cuerpo" }, texto);
  if (adj?.length) cuerpo.append(el("div", { class: "chips-adj" }, adj.map((a) => el("span", {}, "📎 " + a.nombre))));
  cont.append(el("div", { class: "msj usuario" }, cuerpo));
  cont.scrollTop = cont.scrollHeight;
}

function nuevaRespuesta() {
  const cont = $("mensajes"); bienvenida.remove();
  const eventos = el("div"), progreso = el("div", { class: "progreso" }), archivos = el("div", { class: "archivos" });
  const md = el("div", { class: "md" }), pensando = el("div", { class: "pensando" }, el("i"), el("i"), el("i"));
  const cuerpo = el("div", { class: "cuerpo" }, eventos, progreso, archivos, pensando, md);
  const nodo = el("div", { class: "msj asistente" }, el("img", { class: "avatar", src: "../logo.svg", alt: "" }), cuerpo);
  cont.append(nodo);
  const chips = new Map();
  let pendiente = false;
  const v = {
    texto: "",
    pintar(final = false) {
      pensando.remove();
      renderMd(md, v.texto || "");
      md.classList.toggle("cursor", !final);
      const cerca = cont.scrollHeight - cont.scrollTop - cont.clientHeight < 160;
      if (cerca) cont.scrollTop = cont.scrollHeight;
    },
    agregar(d) {
      v.texto += d;
      if (!pendiente) { pendiente = true; requestAnimationFrame(() => { pendiente = false; v.pintar(false); }); }
    },
    evento(ev) {
      const clave = ev.nombre + "|" + (ev.desc || "");
      let chip = chips.get(clave);
      if (!chip) { chip = el("span", { class: "evento" }); chips.set(clave, chip); eventos.append(chip); }
      chip.textContent = "";
      chip.className = "evento" + (ev.estado === "ok" ? " ok" : ev.estado === "error" ? " error" : "");
      chip.append(ev.estado === "inicio" ? el("span", { class: "giro" }) : el("span", {}, ev.estado === "ok" ? "✓" : "✕"),
        el("span", {}, ev.etiqueta || ev.nombre),
        ev.desc ? el("span", { class: "desc", title: ev.desc }, ev.desc) : null,
        ev.segundos ? el("span", { class: "desc" }, `${ev.segundos} s`) : null);
      if (ev.estado === "error" && ev.error) chip.title = ev.error;
      if (ev.estado !== "inicio") progreso.textContent = "";
    },
    progreso(t) { progreso.textContent = t; },
    archivo(a) { pensando.remove(); archivos.append(tarjetaArchivo(a)); },
    error(t) { pensando.remove(); md.classList.remove("cursor"); cuerpo.append(el("div", { class: "error-msj" }, t)); },
    pie(nv, tokens, modelo) {
      cuerpo.append(el("div", { class: "pie-msj" }, `${NOMBRE_NIVEL[nv] || ""}${tokens ? " · " + fmt(tokens) + " tokens" : ""}`,
        modelo ? el("span", { class: "modelo", title: "Solo lo ve el administrador" }, ` · 🛠 ${modelo.modelo}${modelo.detalle ? " · " + modelo.detalle : ""}`) : null));
    },
  };
  return v;
}

function tarjetaArchivo(a) {
  const caja = el("div");
  const mime = a.mime || "";
  Promise.all([
    sb.storage.from("archivos").createSignedUrl(a.ruta, 3600),
    sb.storage.from("archivos").createSignedUrl(a.ruta, 3600, { download: a.nombre }),
  ]).then(([ver, bajar]) => {
    const url = ver.data?.signedUrl, urlBajar = bajar.data?.signedUrl;
    if (!url) { caja.append(el("div", { class: "tarjeta-arch" }, el("span", { class: "ico" }, "⚠️"), el("div", { class: "meta" }, el("b", {}, a.nombre), el("small", {}, "El archivo ya no está disponible")))); return; }
    const acc = el("div", { class: "archivo-acc" }, el("a", { href: urlBajar, download: a.nombre }, "⬇ Descargar"), el("span", { class: "mono", style: "font-size:10.5px" }, a.nombre + " · " + tam(a.bytes || 0)));
    if (mime.startsWith("image/")) {
      const img = el("img", { src: url, alt: a.nombre, loading: "lazy" });
      img.onclick = () => { const v = el("div", { class: "visor", onclick: () => v.remove() }, el("img", { src: url, alt: a.nombre })); document.body.append(v); };
      caja.append(el("div", { class: "archivo-img" }, img), acc);
    } else if (mime.startsWith("video/")) {
      caja.append(el("div", { class: "archivo-vid" }, el("video", { src: url, controls: true, playsinline: true, preload: "metadata" })), acc);
    } else if (mime.startsWith("audio/")) {
      caja.append(el("div", { class: "archivo-aud" }, el("audio", { src: url, controls: true, preload: "metadata" })), acc);
    } else {
      const ico = /sheet|excel|csv/.test(mime) ? "📊" : /word|document/.test(mime) ? "📄" : /pdf/.test(mime) ? "📕" : /presentation/.test(mime) ? "📽️" : /zip/.test(mime) ? "🗜️" : /text/.test(mime) ? "📝" : "📁";
      caja.append(el("div", { class: "tarjeta-arch" }, el("span", { class: "ico" }, ico),
        el("div", { class: "meta" }, el("b", {}, a.nombre), el("small", {}, tam(a.bytes || 0))),
        el("a", { href: urlBajar, download: a.nombre }, "Descargar")));
    }
  });
  return caja;
}

/* ───────── Envío y streaming ───────── */
async function enviar({ mensaje = "", accion = null, params = {} } = {}) {
  if (ocupado) return;
  if (!API_LISTA) { alert("Simbi se está terminando de instalar. Intenta de nuevo pronto."); return; }
  if (pruebaVencida()) { pintarPrueba(); $("dlg-limites").showModal(); return; }
  if (adjuntos.some((a) => a.subiendo)) { alert("Espera a que terminen de subir los archivos."); return; }
  const adj = adjuntos.map(({ ruta, nombre, mime, bytes }) => ({ ruta, nombre, mime, bytes }));
  if (!mensaje.trim() && !accion && !adj.length) return;

  ocupado = true; alternarEnvio(true);
  pintarUsuario(mensaje || etiquetaAccion(accion, params), adj);
  $("texto").value = ""; adjuntos = []; pintarAdjuntos(); contar(); sugerir();
  const v = nuevaRespuesta();
  control = new AbortController();
  try {
    const r = await fetch(API + "/chat", {
      method: "POST", signal: control.signal,
      headers: { Authorization: "Bearer " + await token(), "Content-Type": "application/json" },
      body: JSON.stringify({ conversacion_id: convActual, mensaje, nivel, adjuntos: adj, accion, params }),
    });
    if (!r.ok) {
      let msg = `Error ${r.status}`;
      try { msg = (await r.json()).detail || msg; } catch { /* sin cuerpo */ }
      throw new Error(msg);
    }
    const lector = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const bloque = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const linea of bloque.split("\n")) if (linea.startsWith("data:")) manejar(JSON.parse(linea.slice(5)), v);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") v.error("Detuviste la respuesta. (El servidor puede terminar la tarea y guardarla en el historial.)");
    else v.error(String(e.message || e));
  } finally {
    v.pintar(true);
    ocupado = false; control = null; alternarEnvio(false);
  }
}

function manejar(ev, v) {
  switch (ev.t) {
    case "conv":
      if (convActual !== ev.id) {
        convActual = ev.id; guardar("simb_conv_" + usuario.id, ev.id);
        if (!conversaciones.some((c) => c.id === ev.id)) conversaciones.unshift({ id: ev.id, titulo: ev.titulo, actualizado: new Date().toISOString() });
        $("titulo-conv").textContent = ev.titulo; pintarLista();
      }
      break;
    case "texto": v.agregar(ev.d); break;
    case "herramienta": v.evento(ev); break;
    case "progreso": v.progreso(ev.msg); break;
    case "archivo": v.archivo(ev); break;
    case "error": v.error(ev.msg); break;
    case "fin":
      v.pintar(true); v.pie(ev.nivel, ev.tokens, ev.modelo);
      if (ev.estado) { estado = ev.estado; pintarCupos(); contar(); }
      const c = conversaciones.find((x) => x.id === convActual);
      if (c) { c.actualizado = new Date().toISOString(); conversaciones = [c, ...conversaciones.filter((x) => x !== c)]; pintarLista(); }
      break;
  }
}

function alternarEnvio(activo) { $("btn-enviar").hidden = activo; $("btn-parar").hidden = !activo; }
$("btn-parar").onclick = () => control?.abort();
$("form-chat").onsubmit = (e) => { e.preventDefault(); enviar({ mensaje: $("texto").value }); };
$("texto").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer:fine)").matches) { e.preventDefault(); $("form-chat").requestSubmit(); }
});
$("texto").addEventListener("input", () => { contar(); sugerir(); autoAltura(); });
function autoAltura() { const t = $("texto"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 220) + "px"; }

function contar() {
  const { palabras, tokens } = estimarTokens($("texto").value);
  $("contador").textContent = `${fmt(palabras)} palabras · ~${fmt(tokens)} tokens`;
  if (estado) {
    const quedan = Math.max(0, estado.limites.chat_tokens - estado.usado.chat_tokens);
    $("restante").textContent = `Te quedan ${fmt(quedan)} tokens esta semana`;
  }
}

/* ───────── Sugerencias según lo que escribes o adjuntas ───────── */
function sugerir() {
  const caja = $("sugeridos"); caja.textContent = "";
  if (!esPro()) { caja.hidden = true; return; }
  const yt = $("texto").value.match(RX_YT);
  if (yt) {
    caja.append(el("button", { type: "button", onclick: () => enviar({ accion: "youtube_mp4", params: { url: yt[0] } }) }, "⬇️ Descargar video MP4"),
      el("button", { type: "button", onclick: () => enviar({ accion: "youtube_mp3", params: { url: yt[0] } }) }, "🎵 Solo audio MP3"));
  }
  const medio = adjuntos.find((a) => !a.subiendo && /^(audio|video)\//.test(a.mime));
  if (medio) caja.append(el("button", { type: "button", onclick: () => enviar({ accion: "transcribir", params: { archivo: medio.nombre } }) }, "📝 Transcribir " + medio.nombre));
  const img = adjuntos.find((a) => !a.subiendo && a.mime.startsWith("image/"));
  if (img) caja.append(el("button", { type: "button", onclick: () => abrirAtajo("imagen", true) }, "🎨 Editar esta imagen con IA"));
  caja.hidden = !caja.childElementCount;
}

/* ───────── Adjuntos ───────── */
$("btn-adjuntar").onclick = () => { if (!esPro()) return alert("Subir archivos es parte de la versión Pro."); $("archivo").accept = ""; $("archivo").click(); };
$("archivo").onchange = async (e) => { await subirArchivos([...e.target.files]); e.target.value = ""; };
document.addEventListener("dragover", (e) => { if (esPro()) e.preventDefault(); });
document.addEventListener("drop", (e) => { if (!esPro() || !e.dataTransfer?.files?.length) return; e.preventDefault(); subirArchivos([...e.dataTransfer.files]); });
document.addEventListener("paste", (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length && esPro()) subirArchivos(fs); });

async function subirArchivos(lista) {
  const subidos = [];
  for (const f of lista) {
    if (f.size > MAX_BYTES) { alert(`"${f.name}" supera 50 MB.`); continue; }
    const a = { clave: crypto.randomUUID(), nombre: f.name, mime: mimeDe(f), bytes: f.size, subiendo: true };
    a.ruta = `subidas/${usuario.id}/${a.clave.slice(0, 8)}-${seguro(f.name)}`;
    adjuntos.push(a); pintarAdjuntos();
    subidos.push(sb.storage.from("archivos").upload(a.ruta, f, { contentType: a.mime, upsert: true }).then(({ error }) => {
      if (error) { alert(`No se pudo subir "${f.name}": ${error.message}`); adjuntos = adjuntos.filter((x) => x !== a); }
      a.subiendo = false; pintarAdjuntos(); sugerir();
      return error ? null : a;
    }));
  }
  return (await Promise.all(subidos)).filter(Boolean);
}
function pintarAdjuntos() {
  const c = $("adjuntos"); c.textContent = "";
  for (const a of adjuntos) {
    c.append(el("span", { class: "adj" + (a.subiendo ? " subiendo" : "") },
      el("span", {}, (a.subiendo ? "⏳ " : "📎 ") + a.nombre),
      el("button", { type: "button", "aria-label": "Quitar", onclick: () => { adjuntos = adjuntos.filter((x) => x !== a); pintarAdjuntos(); sugerir(); } }, "✕")));
  }
}

/* ───────── Atajos (no gastan tokens de chat) ───────── */
const ATAJOS = [
  { id: "imagen", ico: "🎨", titulo: "Crear una imagen", desc: "Describe lo que imaginas", pro: true },
  { id: "video", ico: "🎬", titulo: "Video de 3 segundos", desc: "Un clip con IA (Veo)", pro: true },
  { id: "voz", ico: "🔊", titulo: "Texto a voz", desc: "Chirp HD o voz expresiva Gemini", pro: true },
  { id: "transcribir", ico: "📝", titulo: "Transcribir audio o video", desc: "Convierte lo que dicen en texto", pro: true },
  { id: "youtube", ico: "⬇️", titulo: "Descargar de YouTube", desc: "Video MP4 o solo audio MP3", pro: true },
  { id: "oficina", ico: "📊", titulo: "Excel, Word o PDF", desc: "Tablas, informes, gráficos", pro: true },
  { id: "analizar", ico: "📁", titulo: "Analizar archivos", desc: "PDF, Word, Excel, código o ZIP", pro: true },
  { id: "redactar", ico: "✍️", titulo: "Redactar un texto", desc: "Correos, publicaciones, guiones", pro: false },
];
function pintarAtajos() {
  const c = $("atajos"); c.textContent = "";
  for (const a of ATAJOS) {
    const bloqueado = a.pro && !esPro();
    c.append(el("button", { type: "button", class: "atajo" + (bloqueado ? " bloqueado" : ""), onclick: () => bloqueado ? alert("Esta función es parte de la versión Pro. Pídela al administrador.") : abrirAtajo(a.id) },
      el("b", {}, `${a.ico} ${a.titulo}`), el("small", {}, a.desc), bloqueado ? el("span", { class: "bloq" }, "PRO") : null));
  }
}

function campoOpciones(nombre, opciones, valor) {
  return el("div", { class: "opciones" }, opciones.map(([v, t]) =>
    el("label", {}, el("input", { type: "radio", name: nombre, value: v, checked: v === valor }), t)));
}
function abrirDialogo(titulo, campos, nota, okTexto, alAceptar) {
  const dlg = $("dlg");
  $("dlg-titulo").textContent = titulo; $("dlg-nota").textContent = nota || "";
  $("dlg-ok").textContent = okTexto || "Crear";
  const c = $("dlg-campos"); c.textContent = ""; c.append(...campos);
  dlg.onclose = () => { if (dlg.returnValue === "ok") alAceptar(new FormData($("dlg-form"))); };
  dlg.returnValue = ""; dlg.showModal();
}
const quedan = (k, l) => Math.max(0, (estado?.limites?.[l] || 0) - (estado?.usado?.[k] || 0));

async function abrirAtajo(id, conAdjunta = false) {
  const texto = $("texto");
  if (id === "imagen") {
    abrirDialogo(conAdjunta ? "Editar imagen" : "Crear imagen", [
      el("label", {}, "¿Qué quieres ver?", el("textarea", { name: "texto", required: true, placeholder: conAdjunta ? "Ej.: cambia el fondo por un páramo al amanecer" : "Ej.: un colibrí dorado sobre un frailejón al amanecer, foto realista" })),
      campoOpciones("formato", [["1:1", "Cuadrada"], ["4:5", "Instagram 4:5"], ["9:16", "Historia 9:16"], ["16:9", "Horizontal"]], "1:1"),
    ], `Te quedan ${quedan("imagenes", "imagenes")} imágenes esta semana.`, "Crear imagen",
      (f) => f.get("texto")?.trim() && enviar({ accion: "imagen", params: { texto: f.get("texto").trim(), formato: f.get("formato") } }));
  } else if (id === "video") {
    abrirDialogo("Video de 3 segundos", [
      el("label", {}, "Describe la escena", el("textarea", { name: "texto", required: true, placeholder: "Ej.: una bandada de estorninos al atardecer, cámara lenta" })),
      campoOpciones("formato", [["9:16", "Vertical 9:16"], ["16:9", "Horizontal 16:9"]], "9:16"),
    ], `Te quedan ${quedan("videos", "videos")} videos esta semana. Tarda alrededor de un minuto.`, "Crear video",
      (f) => f.get("texto")?.trim() && enviar({ accion: "video", params: { texto: f.get("texto").trim(), formato: f.get("formato") } }));
  } else if (id === "voz") {
    const sel = el("select", { name: "voz" }, ["Femenina", "Masculina"].map((g) =>
      el("optgroup", { label: "Voces " + g.toLowerCase() + "s" }, VOCES.filter((v) => v.genero === g)
        .map((v) => el("option", { value: v.id, selected: v.id === "Puck" ? true : null }, `${g} · ${v.tipo}`)))));
    abrirDialogo("Texto a voz", [
      el("label", {}, "Texto", el("textarea", { name: "texto", required: true, placeholder: "Escribe o pega el texto que quieres escuchar" })),
      campoOpciones("motor", [["chirp", "Chirp HD (natural)"], ["gemini", "Gemini (expresiva, para videos)"]], "chirp"),
      el("label", {}, "Voz", sel),
      el("label", {}, "Estilo (solo Gemini)", el("input", { type: "text", name: "estilo", placeholder: "Ej.: con entusiasmo y ritmo rápido" })),
    ], `Te quedan ${(quedan("tts_chirp_seg", "tts_chirp_seg") / 60).toFixed(0)} min de Chirp y ${(quedan("tts_gemini_seg", "tts_gemini_seg") / 60).toFixed(0)} min de Gemini.`, "Generar audio",
      (f) => f.get("texto")?.trim() && enviar({ accion: f.get("motor") === "gemini" ? "voz_gemini" : "voz_chirp", params: { texto: f.get("texto").trim(), voz: f.get("voz"), estilo: f.get("estilo") || "" } }));
  } else if (id === "youtube") {
    abrirDialogo("Descargar de YouTube", [
      el("label", {}, "Enlace del video", el("input", { type: "url", name: "url", required: true, placeholder: "https://www.youtube.com/watch?v=…" })),
      campoOpciones("formato", [["mp4", "Video MP4"], ["mp3", "Solo audio MP3"]], "mp4"),
      campoOpciones("calidad", [["baja", "Baja"], ["media", "Media"], ["alta", "Alta"]], "media"),
    ], "Máximo 48 MB por archivo. Descarga solo contenido que tengas derecho a usar.", "Descargar",
      (f) => RX_YT.test(f.get("url") || "") ? enviar({ accion: "youtube_" + f.get("formato"), params: { url: f.get("url"), calidad: f.get("calidad") } }) : alert("Ese no parece un enlace de YouTube."));
  } else if (id === "transcribir") {
    $("archivo").accept = "audio/*,video/*";
    $("archivo").onchange = async (e) => {
      const [a] = await subirArchivos([...e.target.files].slice(0, 1)); e.target.value = "";
      $("archivo").onchange = async (ev) => { await subirArchivos([...ev.target.files]); ev.target.value = ""; };
      if (a) enviar({ accion: "transcribir", params: { archivo: a.nombre } });
    };
    $("archivo").click();
  } else if (id === "analizar") {
    texto.value = "Analiza estos archivos y dime los puntos clave: ";
    $("archivo").accept = ""; $("archivo").click(); texto.focus(); contar();
  } else if (id === "oficina") {
    texto.value = "Crea un archivo Excel con "; texto.focus(); contar();
  } else if (id === "redactar") {
    texto.value = "Redacta "; texto.focus(); contar();
  }
}
function etiquetaAccion(accion, p) {
  return ({ imagen: "🎨 Imagen: ", video: "🎬 Video: ", voz_chirp: "🔊 Voz Chirp: ", voz_gemini: "🔊 Voz Gemini: ",
    youtube_mp4: "⬇️ YouTube MP4: ", youtube_mp3: "🎵 YouTube MP3: ", transcribir: "📝 Transcribir: " })[accion] +
    (p.texto || p.url || p.archivo || "");
}

/* ───────── Móvil ───────── */
function cerrarLateral() { $("lateral").classList.remove("abierta"); $("velo").hidden = true; }
$("btn-menu").onclick = () => { $("lateral").classList.add("abierta"); $("velo").hidden = false; };
$("btn-cerrar-lat").onclick = cerrarLateral;
$("velo").onclick = cerrarLateral;

/* ───────── Arranque ───────── */
const { data } = await sb.auth.getSession();
if (!data.session) mostrarAcceso();
