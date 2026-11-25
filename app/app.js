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
const RX_YT = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{6,}[^\s]*/i;
// Deja solo el ID del video: quita ?si=, &t=, &list=, etc. (youtu.be/ID?si=… → youtube.com/watch?v=ID)
function limpiarYT(url) {
  const m = String(url).match(/(?:youtu\.be\/|[?&]v=|shorts\/|live\/|embed\/)([\w-]{11})/);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : url;
}
const enlacesYT = (texto) => [...new Set((String(texto).match(new RegExp(RX_YT.source, "gi")) || []).map(limpiarYT))];
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

/* Ingreso con Google (OAuth de Supabase). Al volver, supabase-js lee la sesión de la URL. */
if (CONFIG.GOOGLE_LOGIN) $("bloque-google").hidden = false;
$("btn-google").onclick = async () => {
  $("btn-google").disabled = true;
  const { error } = await sb.auth.signInWithOAuth({ provider: "google",
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } } });
  if (error) { avisoAcceso("No se pudo abrir Google: " + error.message); $("btn-google").disabled = false; }
};
{ // si Google devolvió un error (p. ej. el usuario canceló), mostrarlo
  const q = new URLSearchParams(location.search + "&" + location.hash.slice(1));
  if (q.get("error_description")) { avisoAcceso("Google: " + q.get("error_description").replace(/\+/g, " ")); history.replaceState(null, "", location.pathname); }
}

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
  cargarTelegram();
  const ultima = leer("simb_conv_" + usuario.id);
  if (ultima && conversaciones.some((c) => c.id === ultima)) abrirConversacion(ultima); else nuevaConversacion();
  cargarMusica();
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

/* ───────── 📲 Avisos por Telegram (@SimbiAlertasBot) ───────── */
const tg = { conectado: false, usuario: "" };
async function cargarTelegram() {
  try {
    Object.assign(tg, await apiNube("/telegram"));
    $("telegram-estado").textContent = tg.conectado ? "✓" : "";
    $("btn-telegram").title = tg.conectado ? `Conectado${tg.usuario ? " como " + tg.usuario : ""} · toca para desconectar`
                                           : "Recibe avisos de Simbi en Telegram";
  } catch { /* sin conexión: el botón sigue disponible */ }
}
$("btn-telegram").onclick = async () => {
  try {
    if (tg.conectado) {
      if (!confirm(`Telegram está conectado${tg.usuario ? " (" + tg.usuario + ")" : ""}.\n¿Quieres desconectarlo y dejar de recibir avisos?`)) return;
      await apiNube("/telegram", { method: "DELETE" });
    } else {
      const ventana = window.open("about:blank", "_blank");   // se abre ya para que el navegador no la bloquee
      const { url } = await apiNube("/telegram/vincular", { method: "POST" });
      if (ventana) ventana.location = url; else location.href = url;
      alert("En Telegram toca «Iniciar» y listo: te avisaré cuando tus descargas y archivos estén listos.");
    }
  } catch (e) { alert("No se pudo: " + e.message); }
  cargarTelegram();
};
window.addEventListener("focus", () => { if (!tg.conectado) cargarTelegram(); });

/* ───────── ☁️ Mi nube: almacenamiento personal (Google Cloud Storage, cupo por plan) ───────── */
const nube = { lista: [], usado: 0, limite: 0, filtro: "todos", urls: new Map() };
const gb = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : tam(b);
async function apiNube(ruta, opciones = {}) {
  const r = await fetch(API + ruta, { ...opciones, headers: { Authorization: "Bearer " + await token(),
    ...(opciones.body ? { "Content-Type": "application/json" } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `Error ${r.status}`);
  return j;
}
function pintarCupoNube() {
  const pct = nube.limite ? Math.min(100, nube.usado / nube.limite * 100) : 0;
  $("nube-uso").textContent = nube.limite ? `${gb(nube.usado)} de ${gb(nube.limite)}` : "No incluido en tu plan";
  $("nube-barra").style.width = pct + "%";
  $("nube-barra").style.background = pct > 90 ? "#ff8a8a" : "";
  $("nube-resumen").textContent = nube.limite ? `${Math.round(pct)}%` : "";
}
async function cargarNube() {
  const g = $("nube-galeria");
  try {
    const d = await apiNube("/nube");
    Object.assign(nube, { lista: d.archivos, usado: d.usado, limite: d.limite });
  } catch (e) { g.textContent = ""; g.append(el("div", { class: "vacio" }, "No se pudo cargar tu nube: " + e.message)); return; }
  pintarCupoNube(); pintarNube();
}
async function abrirNube() {
  $("dlg-nube").showModal();
  const g = $("nube-galeria"); g.textContent = ""; g.append(el("div", { class: "vacio" }, "Cargando…"));
  await cargarNube();
}
function pintarNube() {
  const f = $("nube-filtros"); f.textContent = "";
  for (const t of TIPOS_ARCH) {
    const n = nube.lista.filter((a) => t.es(a.mime)).length;
    if (t.id !== "todos" && !n) continue;
    f.append(el("button", { type: "button", role: "tab", "aria-selected": String(nube.filtro === t.id),
      onclick: () => { nube.filtro = t.id; pintarNube(); } }, t.nombre, el("small", {}, String(n))));
  }
  const tipo = TIPOS_ARCH.find((t) => t.id === nube.filtro) || TIPOS_ARCH[0];
  const lista = nube.lista.filter((a) => tipo.es(a.mime)).slice(0, 300);
  const g = $("nube-galeria"); g.textContent = "";
  if (!lista.length) {
    g.append(el("div", { class: "vacio" }, nube.limite ? "Tu nube está vacía. Sube fotos, videos o documentos para guardarlos aquí."
      : "«Mi nube» está disponible en la versión Pro (5 GB).")); return;
  }
  const tarjetas = lista.map((a) => {
    const vista = el("div", { class: "vista" }, iconoArch(a.mime));
    const acc = el("div", { class: "acc" });
    const fecha = new Date(a.creado).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
    acc.append(
      el("button", { type: "button", onclick: () => bajarNube(a) }, "⬇ Descargar"),
      el("button", { type: "button", class: "peligro", onclick: () => borrarNube(a) }, "🗑 Borrar"));
    g.append(el("div", { class: "item-arch" }, vista, el("div", { class: "info" }, el("b", { title: a.nombre }, a.nombre),
      el("small", {}, `${fecha} · ${gb(a.bytes)}`), acc)));
    return { a, vista };
  });
  const conVista = tarjetas.filter(({ a }) => /^(image|video|audio)\//.test(a.mime));
  const faltan = conVista.filter(({ a }) => !nube.urls.has(a.id)).map(({ a }) => a.id);
  const lotes = []; for (let i = 0; i < faltan.length; i += 60) lotes.push(faltan.slice(i, i + 60));
  Promise.all(lotes.map((ids) => apiNube("/nube/urls", { method: "POST", body: JSON.stringify({ ids }) })
    .then((u) => Object.entries(u).forEach(([k, v]) => nube.urls.set(k, v))).catch(() => {}))).then(() => {
    for (const { a, vista } of conVista) {
      const url = nube.urls.get(a.id); if (!url) continue;
      vista.textContent = "";
      if (a.mime.startsWith("image/")) {
        vista.append(el("img", { src: url, alt: a.nombre, loading: "lazy" }));
        vista.onclick = () => { const v = el("div", { class: "visor", onclick: () => v.remove() }, el("img", { src: url, alt: a.nombre })); document.body.append(v); };
      } else if (a.mime.startsWith("video/")) vista.append(el("video", { src: url, controls: true, playsinline: true, preload: "metadata" }));
      else vista.append(el("audio", { src: url, controls: true, preload: "none" }));
    }
  });
  for (const { a, vista } of tarjetas) if (!/^(image|video|audio)\//.test(a.mime)) vista.onclick = () => abrirEnPestana(a);
}
async function abrirEnPestana(a) {
  const w = window.open("", "_blank");
  try { const u = await apiNube("/nube/urls", { method: "POST", body: JSON.stringify({ ids: [a.id] }) }); w.location = u[a.id]; }
  catch (e) { w.close(); alert(e.message); }
}
async function bajarNube(a) {
  try {
    const u = await apiNube("/nube/urls", { method: "POST", body: JSON.stringify({ ids: [a.id], descargar: true }) });
    const l = el("a", { href: u[a.id], download: a.nombre }); document.body.append(l); l.click(); l.remove();
  } catch (e) { alert("No se pudo descargar: " + e.message); }
}
async function borrarNube(a) {
  if (!confirm(`¿Borrar «${a.nombre}» de tu nube? No se puede deshacer.`)) return;
  try { await apiNube("/nube/" + a.id, { method: "DELETE" }); } catch (e) { alert(e.message); return; }
  nube.lista = nube.lista.filter((x) => x.id !== a.id); nube.usado -= a.bytes; nube.urls.delete(a.id);
  pintarCupoNube(); pintarNube();
}
function putConProgreso(url, archivo, encabezados, alAvanzar) {
  return new Promise((ok, mal) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    for (const [k, v] of Object.entries(encabezados)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && alAvanzar(e.loaded / e.total);
    x.onload = () => (x.status >= 200 && x.status < 300 ? ok() : mal(new Error(`GCS ${x.status}`)));
    x.onerror = () => mal(new Error("Se cortó la conexión"));
    x.send(archivo);
  });
}
async function subirNube(archivos) {
  const cont = $("nube-subidas");
  for (const archivo of archivos) {                // uno por uno: más estable en celulares
    const barra = el("i", { style: "width:0" }), est = el("b", {}, "0%");
    const fila = el("div", { class: "nube-sub" }, el("div", { class: "fila" }, el("span", {}, archivo.name), est), el("div", { class: "barra-c" }, barra));
    cont.append(fila);
    try {
      const r = await apiNube("/nube/subir", { method: "POST", body: JSON.stringify({ nombre: archivo.name, mime: archivo.type || "application/octet-stream", bytes: archivo.size }) });
      await putConProgreso(r.url, archivo, r.encabezados, (p) => { barra.style.width = (p * 100).toFixed(0) + "%"; est.textContent = (p * 100).toFixed(0) + "%"; });
      await apiNube(`/nube/${r.id}/listo`, { method: "POST" });
      est.textContent = "✓"; setTimeout(() => fila.remove(), 2500);
    } catch (e) { fila.classList.add("error"); est.textContent = e.message; setTimeout(() => fila.remove(), 9000); }
    await cargarNube();
  }
}
$("btn-nube").onclick = abrirNube;
$("nube-input").onchange = (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) subirNube(fs); };
{
  const z = $("dlg-nube");
  z.addEventListener("dragover", (e) => { e.preventDefault(); $("nube-galeria").classList.add("arrastrando"); });
  z.addEventListener("dragleave", (e) => { if (!z.contains(e.relatedTarget)) $("nube-galeria").classList.remove("arrastrando"); });
  z.addEventListener("drop", (e) => { e.preventDefault(); $("nube-galeria").classList.remove("arrastrando"); const fs = [...(e.dataTransfer?.files || [])]; if (fs.length) subirNube(fs); });
}

/* ───────── 🎧 Mi música: reproductor de los audios descargados ───────── */
const musica = { todas: [], cola: [], i: -1, aleatorio: true, repetir: "no", conVoces: false, verOcultas: false, ocultas: new Set(), audio: new Audio() };
musica.audio.preload = "metadata";
const tiempo = (s) => !isFinite(s) ? "0:00" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const tituloCancion = (n) => n.replace(/^voz_/, "Voz ").replace(/\.(mp3|m4a|wav|ogg|aac|opus)$/i, "").replace(/[_]+/g, " ").trim();

async function cargarMusica() {
  const oc = await sb.from("musica_oculta").select("ruta");
  musica.ocultas = new Set((oc.data || []).map((x) => x.ruta));
  const { data } = await sb.from("mensajes").select("id,adjuntos,eventos,creado")
    .eq("rol", "asistente").neq("adjuntos", "[]").order("id", { ascending: false }).limit(600);
  const vistos = new Set(), titulos = new Set();
  musica.todas = (data || []).flatMap((m) => {
    const deYoutube = (m.eventos || []).some((e) => e.nombre === "descargar_youtube");
    return (m.adjuntos || []).filter((a) => (a.mime || "").startsWith("audio/") && a.ruta && !vistos.has(a.ruta) && vistos.add(a.ruta))
      .map((a) => ({ ...a, titulo: tituloCancion(a.nombre), youtube: deYoutube && !/^voz_/.test(a.nombre), creado: m.creado }));
  }).filter((c) => {                     // la misma canción descargada varias veces aparece una sola vez (la más reciente)
    const k = c.titulo.toLowerCase();
    if (titulos.has(k)) return false;
    titulos.add(k); return true;
  });
  $("musica-n").textContent = String(musica.todas.filter((c) => c.youtube && !musica.ocultas.has(c.ruta)).length || "");
}
function listaVisible() {
  const q = $("rep-buscar").value.trim().toLowerCase();
  return musica.todas.filter((c) => (musica.conVoces || c.youtube) && (!q || c.titulo.toLowerCase().includes(q))
    && musica.ocultas.has(c.ruta) === musica.verOcultas);
}
function armarCola(empezarCon) {
  const base = listaVisible();
  const resto = base.filter((c) => c !== empezarCon);
  if (musica.aleatorio) for (let k = resto.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [resto[k], resto[j]] = [resto[j], resto[k]]; }
  musica.cola = empezarCon ? [empezarCon, ...resto] : resto;
  musica.i = -1;
}
async function tocar(i) {
  if (!musica.cola.length) return;
  musica.i = (i + musica.cola.length) % musica.cola.length;
  const c = musica.cola[musica.i];
  if (!c.url || c.vence < Date.now()) {
    const { data } = await sb.storage.from("archivos").createSignedUrl(c.ruta, 6 * 3600);
    if (!data?.signedUrl) { c.roto = true; return tocar(musica.i + 1); }
    c.url = data.signedUrl; c.vence = Date.now() + 5.5 * 3600 * 1000;
  }
  musica.audio.src = c.url;
  try { await musica.audio.play(); } catch { /* el navegador pide un clic */ }
  pintarMusica();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: c.titulo, artist: "Mi música · Simbi", artwork: [{ src: new URL("../logo.svg", location.href).href, sizes: "512x512", type: "image/svg+xml" }] });
  }
}
function siguiente(auto = false) {
  if (!musica.cola.length) { armarCola(); }
  if (auto && musica.repetir === "una") return tocar(musica.i);
  if (musica.i + 1 >= musica.cola.length) {
    if (auto && musica.repetir === "no" && !musica.aleatorio) { musica.audio.pause(); pintarMusica(); return; }
    const actual = musica.cola[musica.i]; armarCola(); if (musica.aleatorio && musica.cola[0] === actual && musica.cola.length > 1) musica.cola.push(musica.cola.shift());
    return tocar(0);
  }
  tocar(musica.i + 1);
}
function anterior() { if (musica.audio.currentTime > 4) musica.audio.currentTime = 0; else tocar(musica.i - 1); }
function alternar() {
  if (!musica.audio.src) { armarCola(); return tocar(0); }
  musica.audio.paused ? musica.audio.play() : musica.audio.pause();
}
function pintarMusica() {
  const c = musica.cola[musica.i], sonando = !musica.audio.paused;
  $("rep-titulo").textContent = c ? c.titulo : "Elige una canción";
  $("rep-sub").textContent = c ? `${musica.i + 1} de ${musica.cola.length}${musica.aleatorio ? " · aleatorio" : ""}` : `${listaVisible().length} audios`;
  $("rep-play").textContent = sonando ? "⏸" : "▶"; $("mr-play").textContent = sonando ? "⏸" : "▶";
  $("rep-portada").classList.toggle("sonando", sonando);
  $("mini-rep").hidden = !c; $("mr-titulo").textContent = c ? "🎵 " + c.titulo : "";
  $("rep-aleatorio").setAttribute("aria-pressed", String(musica.aleatorio));
  $("rep-repetir").setAttribute("aria-pressed", String(musica.repetir !== "no"));
  $("rep-repetir").textContent = musica.repetir === "una" ? "🔂" : "🔁";
  $("rep-repetir").title = { no: "Repetir: no", todas: "Repetir: todas", una: "Repetir: esta" }[musica.repetir];
  const lista = $("rep-lista"); lista.textContent = "";
  const vis = listaVisible();
  if (!vis.length) {
    lista.append(el("li", { class: "vacio" }, musica.verOcultas ? "No tienes canciones ocultas." : musica.todas.length ? "Nada coincide con la búsqueda." :
      "Aún no tienes música. Usa «⬇️ Descargar de YouTube» → «Solo audio MP3» (puedes pegar varios enlaces)."));
  }
  vis.forEach((x, k) => lista.append(el("li", { class: x === c ? "actual" : "", onclick: () => { armarCola(x); tocar(0); } },
    el("span", { class: "n" }, x === c && sonando ? "▶" : String(k + 1)), el("span", { class: "t", title: x.titulo }, x.titulo),
    el("span", { class: "d" }, new Date(x.creado).toLocaleDateString("es", { day: "numeric", month: "short" })),
    el("button", { type: "button", class: "ocultar", title: musica.verOcultas ? "Volver a mostrar" : "Ocultar de Mi música",
      "aria-label": musica.verOcultas ? "Volver a mostrar" : "Ocultar", onclick: (e) => { e.stopPropagation(); alternarOculta(x); } }, musica.verOcultas ? "↩" : "✕"))));
}
async function alternarOculta(c) {
  const ocultar = !musica.ocultas.has(c.ruta);
  const { error } = ocultar ? await sb.from("musica_oculta").insert({ ruta: c.ruta })
    : await sb.from("musica_oculta").delete().eq("ruta", c.ruta);
  if (error) return alert("No se pudo: " + error.message);
  ocultar ? musica.ocultas.add(c.ruta) : musica.ocultas.delete(c.ruta);
  if (ocultar) {
    const k = musica.cola.indexOf(c);
    if (k >= 0) { const sonaba = k === musica.i; musica.cola.splice(k, 1); if (k < musica.i) musica.i--; if (sonaba) { musica.i--; siguiente(); } }
  }
  $("musica-n").textContent = String(musica.todas.filter((x) => x.youtube && !musica.ocultas.has(x.ruta)).length || "");
  pintarMusica();
}
async function abrirMusica() {
  $("dlg-musica").showModal();
  await cargarMusica();
  if (!musica.cola.length) armarCola();
  pintarMusica();
}
musica.audio.addEventListener("ended", () => siguiente(true));
musica.audio.addEventListener("error", () => { if (musica.audio.src) setTimeout(() => siguiente(true), 800); });
for (const ev of ["play", "pause"]) musica.audio.addEventListener(ev, pintarMusica);
musica.audio.addEventListener("timeupdate", () => {
  const a = musica.audio, p = a.duration ? a.currentTime / a.duration : 0;
  $("rep-actual").textContent = tiempo(a.currentTime); $("rep-total").textContent = tiempo(a.duration);
  if (!$("rep-barra").matches(":active")) $("rep-barra").value = Math.round(p * 1000);
  $("mr-avance").style.width = (p * 100).toFixed(1) + "%";
});
$("rep-barra").oninput = (e) => { if (musica.audio.duration) musica.audio.currentTime = (e.target.value / 1000) * musica.audio.duration; };
$("rep-volumen").oninput = (e) => { musica.audio.volume = +e.target.value; };
$("rep-play").onclick = alternar; $("mr-play").onclick = alternar;
$("rep-sig").onclick = () => siguiente(); $("mr-sig").onclick = () => siguiente();
$("rep-ant").onclick = anterior; $("mr-ant").onclick = anterior;
$("rep-aleatorio").onclick = () => { musica.aleatorio = !musica.aleatorio; const c = musica.cola[musica.i]; armarCola(c); if (c) musica.i = 0; pintarMusica(); };
$("rep-repetir").onclick = () => { musica.repetir = { no: "todas", todas: "una", una: "no" }[musica.repetir]; pintarMusica(); };
$("rep-buscar").oninput = pintarMusica;
$("rep-voces").onchange = (e) => { musica.conVoces = e.target.checked; pintarMusica(); };
$("rep-ocultas").onchange = (e) => { musica.verOcultas = e.target.checked; pintarMusica(); };
$("btn-musica").onclick = abrirMusica; $("mr-titulo").onclick = abrirMusica;
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => musica.audio.play());
  navigator.mediaSession.setActionHandler("pause", () => musica.audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => siguiente());
  navigator.mediaSession.setActionHandler("previoustrack", anterior);
}

/* ───────── Sugerencias (las lee el administrador) ───────── */
$("btn-sugerir").onclick = () => abrirDialogo("Enviar una sugerencia", [
  campoOpciones("tipo", [["idea", "💡 Idea o función nueva"], ["problema", "🐞 Algo no funciona"], ["otro", "💬 Otro"]], "idea"),
  el("label", {}, "Cuéntanos", el("textarea", { name: "texto", required: true, minlength: 3, maxlength: 4000,
    placeholder: "Ej.: me gustaría poder crear presentaciones de PowerPoint con mis colores" })),
], "La lee el equipo de Simbi para mejorar. ¡Gracias!", "Enviar", async (f) => {
  const texto = f.get("texto")?.trim();
  if (!texto || texto.length < 3) return;
  const { error } = await sb.from("sugerencias").insert({ tipo: f.get("tipo"), texto });
  alert(error ? "No se pudo enviar: " + error.message : "✅ ¡Gracias! Tu sugerencia llegó al equipo.");
});
$("mas-archivos").onclick = () => { galeria.mostrados += POR_PAGINA; pintarGaleria(); };

/* ───────── Conversaciones ───────── */
async function cargarConversaciones() {
  let { data, error } = await sb.from("conversaciones").select("id,titulo,actualizado,nivel,en_proceso").order("actualizado", { ascending: false }).limit(200);
  if (error) ({ data } = await sb.from("conversaciones").select("id,titulo,actualizado,nivel").order("actualizado", { ascending: false }).limit(200));
  conversaciones = data || [];
  pintarLista();
  clearTimeout(relojConv);                       // si alguna sigue procesándose (p. ej. desde otro dispositivo), revisar luego
  if (conversaciones.some(enProceso)) relojConv = setTimeout(cargarConversaciones, 15000);
}
let relojConv = null, convProcesando = null;
// ⏳ si Simbi está respondiendo en esa conversación; 🟢 si ya terminó (15 min de margen por si el servidor se reinició)
const enProceso = (c) => c.id === convProcesando || (c.en_proceso && Date.now() - new Date(c.actualizado) < 15 * 60 * 1000);
const horaCorta = (iso) => { const d = new Date(iso), h = new Date(); return d.toDateString() === h.toDateString()
  ? d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : d.toLocaleDateString("es-CO", { day: "numeric", month: "short" }); };
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
    const proc = enProceso(c);
    ul.append(el("li", { class: c.id === convActual ? "activa" : "" },
      el("button", { class: "ir", type: "button", title: c.titulo + (proc ? " · Simbi está respondiendo…" : " · Lista"), onclick: () => abrirConversacion(c.id) },
        el("span", { class: "est " + (proc ? "proc" : "lista"), "aria-label": proc ? "Procesando" : "Finalizada" }),
        el("span", { class: "tit" }, c.titulo), el("span", { class: "hora" }, horaCorta(c.actualizado))),
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
  const md = el("div", { class: "md" });
  const txtPensando = el("span", { class: "pensando-txt" }, "Simbi está pensando"), segPensando = el("span", { class: "pensando-seg" });
  const pensando = el("div", { class: "pensando", role: "status" }, el("span", { class: "puntos" }, el("i"), el("i"), el("i")), txtPensando, segPensando);
  const t0 = Date.now();
  const reloj = setInterval(() => {
    if (!pensando.isConnected) return clearInterval(reloj);
    const seg = Math.round((Date.now() - t0) / 1000);
    segPensando.textContent = seg >= 3 ? `${seg} s` : "";
  }, 1000);
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
      if (pensando.isConnected) txtPensando.textContent = ev.estado === "inicio" ? (ev.etiqueta || "Trabajando") + "…" : "Simbi está pensando";
    },
    progreso(t) {
      if (pensando.isConnected) txtPensando.textContent = t || "Simbi está pensando";
      else progreso.textContent = t;
    },
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
  convProcesando = convActual || "nueva"; pintarLista();
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
    convProcesando = null; pintarLista();
  }
}

function manejar(ev, v) {
  switch (ev.t) {
    case "conv":
      if (convActual !== ev.id) {
        convActual = ev.id; guardar("simb_conv_" + usuario.id, ev.id); if (ocupado) convProcesando = ev.id;
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
      if (v.texto.includes("Mi música") || v.texto.startsWith("✅ Listo")) cargarMusica();
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
    caja.append(el("button", { type: "button", onclick: () => enviar({ accion: "youtube_mp3", params: { url: limpiarYT(yt[0]) } }) }, "🎵 Solo audio MP3"),
      el("button", { type: "button", onclick: () => enviar({ accion: "youtube_mp4", params: { url: limpiarYT(yt[0]) } }) }, "⬇️ Video MP4"));
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
  { id: "video", ico: "🎬", titulo: "Video con IA", desc: "Clip de 1 a 5 segundos (Veo)", pro: true },
  { id: "voz", ico: "🔊", titulo: "Texto a voz", desc: "Chirp HD o voz expresiva Gemini", pro: true },
  { id: "transcribir", ico: "📝", titulo: "Transcribir audio o video", desc: "Convierte lo que dicen en texto", pro: true },
  { id: "youtube", ico: "⬇️", titulo: "Descargar de YouTube", desc: "Música MP3 o video MP4 · varios enlaces", pro: true },
  { id: "oficina", ico: "📊", titulo: "Excel, Word o PDF", desc: "Tablas, informes, gráficos", pro: true },
  { id: "analizar", ico: "📁", titulo: "Analizar archivos", desc: "PDF, Word, Excel, código o ZIP", pro: true },
  { id: "video_codigo", ico: "🎞️", titulo: "Video con código", desc: "Animación con Python + voz Chirp o Gemini", pro: true },
  { id: "presentacion", ico: "📽️", titulo: "Presentación PowerPoint", desc: "Diapositivas editables con revisión de diseño", pro: true },
  { id: "estudiar", ico: "📚", titulo: "Estudiar", desc: "Quiz, tarjetas o guía de estudio", pro: false },
  { id: "correo", ico: "✉️", titulo: "Redactar un correo", desc: "Plantillas: solicitud, seguimiento, ventas…", pro: false },
  { id: "redactar", ico: "✍️", titulo: "Redactar un texto", desc: "Publicaciones, guiones, artículos, ideas", pro: false },
];

/* Plantillas de prompts para redactar */
const TIPOS_CORREO = [
  ["solicitud", "Solicitud formal", "una solicitud formal", "Ej.: pedir una cita con el rector para presentar el proyecto de robótica"],
  ["seguimiento", "Seguimiento (no me han respondido)", "un seguimiento amable a un mensaje que no han respondido", "Ej.: envié la cotización el lunes y no he recibido respuesta"],
  ["cliente", "Responder a un cliente", "una respuesta a un cliente", "Ej.: el cliente pregunta por el retraso del pedido; llegará el viernes"],
  ["propuesta", "Propuesta comercial / venta", "una propuesta comercial persuasiva", "Ej.: ofrecer talleres de IA para docentes, 3 sesiones, precio especial"],
  ["reunion", "Invitar a una reunión", "una invitación a una reunión", "Ej.: reunión de planeación el jueves 3 p. m. por Meet, 45 min"],
  ["agradecimiento", "Agradecimiento", "un agradecimiento sincero", "Ej.: agradecer al equipo por el apoyo en la feria de ciencias"],
  ["reclamo", "Reclamo o queja", "un reclamo firme y respetuoso", "Ej.: me cobraron dos veces la factura de octubre"],
  ["disculpa", "Disculpa", "una disculpa profesional", "Ej.: no pude asistir a la reunión por un imprevisto"],
  ["cobro", "Recordatorio de pago", "un recordatorio de pago cordial", "Ej.: factura #120 vencida hace 15 días"],
  ["contacto", "Presentarme / contacto en frío", "un primer contacto para presentarme", "Ej.: me presento como ingeniero y ofrezco colaborar en su proyecto"],
  ["renuncia", "Carta de renuncia", "una carta de renuncia respetuosa", "Ej.: renuncio con 15 días de preaviso, agradecido por la experiencia"],
  ["otro", "Otro (lo describo yo)", "un correo", "Describe qué necesitas decir"],
];
const TIPOS_TEXTO = [
  ["post", "Publicación para redes (Instagram / Facebook)", "una publicación para redes sociales con gancho inicial, cuerpo breve, llamado a la acción y hashtags", "Ej.: lanzamiento del curso de robótica para niños"],
  ["linkedin", "Post para LinkedIn", "un post para LinkedIn con historia, aprendizaje y pregunta final", "Ej.: lo que aprendí al automatizar mi trabajo con IA"],
  ["guion", "Guion de video corto (Reels / TikTok)", "un guion de video corto con gancho en los primeros 3 segundos, escenas y texto en pantalla", "Ej.: 3 errores al estudiar para un examen"],
  ["articulo", "Artículo o blog", "un artículo con título, introducción, subtítulos y conclusión", "Ej.: cómo usar la IA en el aula sin hacer trampa"],
  ["mejorar", "Mejorar o corregir mi texto", "una versión mejorada (ortografía, claridad y estilo) del texto que pego, y luego una lista breve de los cambios", "Pega aquí tu texto"],
  ["resumen", "Resumir un texto", "un resumen claro con las ideas principales en viñetas", "Pega aquí el texto a resumir"],
  ["discurso", "Discurso o presentación oral", "un discurso para decir en voz alta, con frases cortas y pausas", "Ej.: palabras de bienvenida a padres de familia, 2 minutos"],
  ["producto", "Descripción de producto o servicio", "una descripción que venda: beneficios, características y llamado a la acción", "Ej.: kit de robótica educativa para colegios"],
  ["bio", "Biografía o perfil profesional", "una biografía profesional", "Ej.: ingeniero, docente, 10 años enseñando tecnología"],
  ["whatsapp", "Mensaje de WhatsApp", "un mensaje de WhatsApp breve y natural", "Ej.: recordar a los padres la salida pedagógica del viernes"],
  ["ideas", "Lluvia de ideas", "una lista de 10 ideas creativas y variadas, cada una con una frase de explicación", "Ej.: ideas de contenido para enseñar matemáticas en redes"],
  ["otro", "Otro (lo describo yo)", "un texto", "Describe qué necesitas"],
];
function selectorPlantilla(nombre, tipos, area) {
  const sel = el("select", { name: nombre }, tipos.map(([id, t]) => el("option", { value: id }, t)));
  sel.onchange = () => { area.placeholder = tipos.find((x) => x[0] === sel.value)[3]; };
  area.placeholder = tipos[0][3];
  return sel;
}
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
    abrirDialogo("Video con IA", [
      el("label", {}, "Describe la escena", el("textarea", { name: "texto", required: true, placeholder: "Ej.: una bandada de estorninos al atardecer, cámara lenta" })),
      campoOpciones("formato", [["9:16", "Vertical 9:16"], ["16:9", "Horizontal 16:9"]], "9:16"),
      el("div", { class: "campo-titulo" }, "Duración"),
      campoOpciones("segundos", [1, 2, 3, 4, 5].map((n) => [String(n), `${n} s`]), "3"),
    ], `Te quedan ${quedan("videos", "videos")} videos esta semana. Tarda alrededor de un minuto.`, "Crear video",
      (f) => f.get("texto")?.trim() && enviar({ accion: "video", params: { texto: f.get("texto").trim(), formato: f.get("formato"), segundos: +f.get("segundos") || 3 } }));
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
      el("label", {}, "Enlaces (uno por línea, hasta 10)", el("textarea", { name: "urls", required: true,
        placeholder: "https://www.youtube.com/watch?v=…\nhttps://youtu.be/…" })),
      campoOpciones("formato", [["mp3", "🎵 Solo audio MP3 (va a «Mi música»)"], ["mp4", "🎬 Video MP4"]], "mp3"),
      campoOpciones("calidad", [["baja", "Baja"], ["media", "Media"], ["alta", "Alta"]], "media"),
    ], "Máximo 48 MB por archivo. Descarga solo contenido que tengas derecho a usar.", "Descargar",
      (f) => {
        const urls = enlacesYT(f.get("urls") || "").slice(0, 10);
        if (!urls.length) return alert("No encontré enlaces de YouTube.");
        enviar({ accion: "youtube_" + f.get("formato"), params: { url: urls.join("\n"), urls, calidad: f.get("calidad") } });
      });
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
  } else if (id === "presentacion") {
    const paletas = [["azul", "Azul corporativo (#1E3A8A, #3B82F6, blanco)"], ["verde", "Verde natural (#14532D, #22C55E, crema)"],
      ["oscuro", "Oscuro moderno (#0F172A, #38BDF8, #F472B6)"], ["calido", "Cálido (#7C2D12, #F97316, #FDE68A)"],
      ["sobrio", "Blanco y negro elegante (#111111, #F5F5F5, acento #D4AF37)"], ["simbi", "Colores de Simbi (#0B1117, #2EE6D6, #FF5A3C)"]];
    abrirDialogo("Presentación PowerPoint", [
      el("label", {}, "Tema", el("textarea", { name: "tema", required: true, placeholder: "Ej.: La ley de Ohm para grado 9, con ejemplos de la vida diaria y ejercicios" })),
      el("label", {}, "Número de diapositivas", el("input", { type: "number", name: "n", min: 3, max: 25, value: 10 })),
      el("label", {}, "Colores", el("select", { name: "paleta" }, paletas.map(([v, t]) => el("option", { value: v }, t)), el("option", { value: "propia" }, "Otros (los escribo abajo)"))),
      el("label", {}, "Colores propios (opcional)", el("input", { type: "text", name: "colores", placeholder: "Ej.: morado y amarillo, o #6D28D9 y #FACC15" })),
      campoOpciones("estilo", [["minimalista", "Minimalista"], ["corporativo", "Corporativo"], ["creativo", "Creativo"], ["educativo", "Educativo"]], "educativo"),
      el("label", { class: "check" }, el("input", { type: "checkbox", name: "notas", checked: true }), " Incluir notas del orador"),
    ], "Simbi crea un .pptx editable y un revisor de diseño mira las diapositivas antes de entregarlo. Si adjuntas un documento (📎) antes, lo usa como fuente. Recomendado: Difícil o Muy complejo.", "Crear presentación",
      (f) => {
        const pal = paletas.find((x) => x[0] === f.get("paleta"));
        const colores = f.get("colores")?.trim() || (pal ? pal[1] : "a tu criterio, sobria");
        enviar({ mensaje: `Crea una presentación de PowerPoint (.pptx editable) de ${Math.min(25, Math.max(3, +f.get("n") || 10))} diapositivas sobre: ${f.get("tema").trim()}\n` +
          `Estilo: ${f.get("estilo")}. Colores: ${colores}.\n` +
          `Incluye portada, agenda, desarrollo con una idea por diapositiva y elementos visuales, y cierre.` +
          (f.get("notas") ? " Agrega notas del orador en cada diapositiva." : "") +
          (adjuntos.length ? " Usa como fuente el documento que adjunto." : "") });
      });
  } else if (id === "estudiar") {
    abrirDialogo("Estudiar", [
      el("label", {}, "Tema o texto (o adjunta un documento con 📎 antes)", el("textarea", { name: "tema", required: !adjuntos.length,
        placeholder: "Ej.: la célula y sus partes · o pega aquí tus apuntes" })),
      el("div", { class: "campo-titulo" }, "¿Qué quieres?"),
      campoOpciones("tipo", [["quiz", "📝 Quiz de opción múltiple"], ["tarjetas", "🃏 Tarjetas de estudio"], ["guia", "📖 Guía de estudio"], ["todo", "✨ Todo"]], "quiz"),
      el("label", {}, "Cantidad de preguntas o tarjetas", el("input", { type: "number", name: "n", min: 3, max: 40, value: 10 })),
      el("div", { class: "campo-titulo" }, "Nivel"),
      campoOpciones("nivel", [["primaria", "Primaria"], ["secundaria", "Secundaria"], ["universidad", "Universidad"], ["profesional", "Profesional"]], "secundaria"),
      el("div", { class: "campo-titulo" }, "Entrega"),
      campoOpciones("salida", [["chat", "En el chat"], ["pdf", "PDF para imprimir"], ["excel", "Excel (tarjetas, importable a Anki/Quizlet)"]], "chat"),
    ], "En el chat es lo más rápido y gasta menos tokens. El PDF y el Excel son de la versión Pro.", "Crear",
      (f) => {
        const tema = f.get("tema")?.trim();
        if (!tema && !adjuntos.length) return;
        const salida = f.get("salida");
        if (salida !== "chat" && !esPro()) return alert("El PDF y el Excel son de la versión Pro. Elige «En el chat».");
        const n = Math.min(40, Math.max(3, +f.get("n") || 10));
        const que = { quiz: `un quiz de ${n} preguntas de opción múltiple (4 opciones, una correcta) con la clave de respuestas y una explicación breve de cada una AL FINAL`,
          tarjetas: `${n} tarjetas de estudio (pregunta → respuesta corta)`,
          guia: "una guía de estudio con conceptos clave, resumen por secciones, ejemplos y errores comunes",
          todo: `una guía de estudio breve, ${n} tarjetas de estudio y un quiz de ${n} preguntas de opción múltiple con la clave de respuestas al final` }[f.get("tipo")];
        const formato = { chat: "Respóndelo aquí en el chat, bien organizado con Markdown.",
          pdf: "Entrégalo como PDF elegante para imprimir (preguntas primero y la clave de respuestas en una página aparte).",
          excel: "Entrégalo como Excel con columnas Pregunta y Respuesta (y Opciones si es quiz), listo para importar a Anki o Quizlet." }[salida];
        enviar({ mensaje: `Ayúdame a estudiar. Crea ${que}, para nivel ${f.get("nivel")}.\n` +
          (tema ? `Tema / contenido: ${tema}\n` : "Usa como contenido el material que adjunto.\n") +
          `Basa todo en información correcta; si adjunto material, cíñete a él. ${formato}` });
      });
  } else if (id === "correo") {
    const area = el("textarea", { name: "puntos", required: true });
    abrirDialogo("Redactar un correo", [
      el("label", {}, "Tipo de correo", selectorPlantilla("tipo", TIPOS_CORREO, area)),
      el("label", {}, "¿Para quién?", el("input", { type: "text", name: "para", placeholder: "Ej.: el rector, un cliente, mi jefe, la profesora Ana" })),
      el("label", {}, "¿Qué quieres decir? (puntos clave)", area),
      campoOpciones("tono", [["formal", "Formal"], ["cercano", "Cercano"], ["persuasivo", "Persuasivo"], ["directo", "Directo"]], "formal"),
      campoOpciones("largo", [["corto", "Corto"], ["medio", "Medio"], ["largo", "Largo"]], "medio"),
    ], "Simbi escribe el asunto (con 2 alternativas), el saludo, el cuerpo y la despedida. Luego puedes pedirle cambios.", "Redactar",
      (f) => {
        const t = TIPOS_CORREO.find((x) => x[0] === f.get("tipo"));
        const para = f.get("para")?.trim();
        enviar({ mensaje: `Redacta ${t[2]}${para ? " dirigido a " + para : ""}.\nPuntos clave: ${f.get("puntos").trim()}\n` +
          `Tono: ${f.get("tono")}. Extensión: ${f.get("largo")}.\nIncluye: asunto (y 2 alternativas), saludo, cuerpo bien organizado y despedida. ` +
          `Usa [corchetes] para los datos que falten. Entrega solo el correo listo para copiar.` });
      });
  } else if (id === "redactar") {
    const area = el("textarea", { name: "tema", required: true });
    abrirDialogo("Redactar un texto", [
      el("label", {}, "¿Qué necesitas?", selectorPlantilla("tipo", TIPOS_TEXTO, area)),
      el("label", {}, "Tema o contenido", area),
      el("label", {}, "Público (opcional)", el("input", { type: "text", name: "publico", placeholder: "Ej.: padres de familia, jóvenes de 15 a 20 años, docentes" })),
      campoOpciones("tono", [["cercano", "Cercano"], ["profesional", "Profesional"], ["inspirador", "Inspirador"], ["divertido", "Divertido"]], "cercano"),
      campoOpciones("largo", [["corto", "Corto"], ["medio", "Medio"], ["largo", "Largo"]], "medio"),
    ], "Elige una plantilla y Simbi arma el pedido completo. Después puedes iterar en el chat.", "Redactar",
      (f) => {
        const t = TIPOS_TEXTO.find((x) => x[0] === f.get("tipo"));
        const publico = f.get("publico")?.trim();
        enviar({ mensaje: `Escribe ${t[2]}.\nTema/contenido: ${f.get("tema").trim()}\n` + (publico ? `Público: ${publico}.\n` : "") +
          `Tono: ${f.get("tono")}. Extensión: ${f.get("largo")}.` });
      });
  } else if (id === "video_codigo") {
    const sel = el("select", { name: "voz" }, ["Femenina", "Masculina"].map((g) =>
      el("optgroup", { label: "Voces " + g.toLowerCase() + "s" }, VOCES.filter((v) => v.genero === g)
        .map((v) => el("option", { value: v.id, selected: v.id === "Puck" ? true : null }, `${g} · ${v.tipo}`)))));
    abrirDialogo("Video con código", [
      el("label", {}, "¿Qué video quieres?", el("textarea", { name: "texto", required: true, placeholder: "Ej.: video explicativo de la ley de Ohm con fondo oscuro, títulos animados, la fórmula V = I × R y un ejemplo con números" })),
      campoOpciones("formato", [["9:16", "Vertical 9:16"], ["16:9", "Horizontal 16:9"]], "9:16"),
      el("label", {}, "Duración aproximada (segundos)", el("input", { type: "number", name: "duracion", min: 5, max: 90, value: 20 })),
      el("div", { class: "campo-titulo" }, "Narración (voz)"),
      campoOpciones("motor", [["ninguna", "Sin voz"], ["chirp", "Chirp HD (natural)"], ["gemini", "Gemini (expresiva)"]], "chirp"),
      el("label", {}, "Voz", sel),
      el("label", {}, "Texto de la narración (opcional: si lo dejas vacío, Simbi lo escribe)", el("textarea", { name: "guion", placeholder: "Escribe exactamente lo que dirá la voz" })),
      el("label", {}, "Estilo de la voz (solo Gemini)", el("input", { type: "text", name: "estilo", placeholder: "Ej.: entusiasta, como profesor joven" })),
    ], `La voz se descuenta de tus minutos (te quedan ${(quedan("tts_chirp_seg", "tts_chirp_seg") / 60).toFixed(0)} min Chirp y ${(quedan("tts_gemini_seg", "tts_gemini_seg") / 60).toFixed(0)} min Gemini). ` +
      "Para música de fondo, adjunta un MP3 (📎) antes de crear. Recomendado: nivel Difícil o Muy complejo. Luego puedes pedir cambios en el chat.", "Crear video",
      (f) => f.get("texto")?.trim() && enviar({ accion: "video_codigo", params: { texto: f.get("texto").trim(), formato: f.get("formato"),
        duracion: Math.min(90, Math.max(5, +f.get("duracion") || 20)), motor: f.get("motor"), voz: f.get("voz"),
        guion: f.get("guion") || "", estilo: f.get("estilo") || "" } }));
  }
}
function etiquetaAccion(accion, p) {
  return ({ imagen: "🎨 Imagen: ", video: "🎬 Video IA: ", voz_chirp: "🔊 Voz Chirp: ", voz_gemini: "🔊 Voz Gemini: ",
    youtube_mp4: "⬇️ YouTube MP4: ", youtube_mp3: "🎵 YouTube MP3: ", transcribir: "📝 Transcribir: ", video_codigo: "🎞️ Video con código: " })[accion] +
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
