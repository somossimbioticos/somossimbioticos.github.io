import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/+esm";
import { CONFIG } from "../config.js";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const API = CONFIG.API_URL;
const API_LISTA = API && !API.startsWith("PENDIENTE");
const $ = (id) => document.getElementById(id);

const NIVELES = [
  { id: "facil", nombre: "Fácil", barras: 1, desc: "Rápido · preguntas del día a día" },
  { id: "medio", nombre: "Medio", barras: 2, desc: "Equilibrado · textos y tareas normales" },
  { id: "dificil", nombre: "Difícil", barras: 3, desc: "Piensa más · análisis, código, cálculos" },
  { id: "complejo", nombre: "Muy complejo", barras: 4, desc: "El más potente · proyectos grandes" },
];
const barrasNivel = (n) => el("span", { class: "barras", "aria-hidden": "true" }, [1, 2, 3, 4].map((i) => el("i", { class: i <= n ? "on" : null })));
const NOMBRE_NIVEL = Object.fromEntries(NIVELES.map((n) => [n.id, n.nombre]));
// Voces (mismo nombre en voz natural y expresiva). Al usuario se le muestra género y tipo de voz.
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
// Publicaciones de redes sociales (se descargan con yt-dlp + gallery-dl en el servidor)
const RX_REDES = /https?:\/\/(?:[\w-]+\.)*(?:instagram\.com|instagr\.am|tiktok\.com|facebook\.com|fb\.watch|fb\.com|x\.com|twitter\.com|threads\.net|threads\.com|pinterest\.(?:com|es|co\.uk)|pin\.it|reddit\.com|redd\.it|vimeo\.com|linkedin\.com|twitch\.tv|soundcloud\.com|dailymotion\.com|dai\.ly|snapchat\.com|kwai\.com)\/[^\s,;<>"']+/i;
const enlacesRedes = (texto) => [...new Set((String(texto).match(new RegExp(RX_REDES.source, "gi")) || []).map((u) => u.replace(/[).]+$/, "")))];
// Nombre e ícono de cada red (para mostrar qué se detectó en los enlaces)
const REDES_UI = [
  { rx: /instagram\.com|instagr\.am/, ico: "📸", nombre: "Instagram" }, { rx: /tiktok\.com/, ico: "🎵", nombre: "TikTok" },
  { rx: /facebook\.com|fb\.watch|fb\.com/, ico: "📘", nombre: "Facebook" }, { rx: /(^|\.)x\.com|twitter\.com/, ico: "✖️", nombre: "X" },
  { rx: /threads\.(net|com)/, ico: "🧵", nombre: "Threads" }, { rx: /pinterest\.|pin\.it/, ico: "📌", nombre: "Pinterest" },
  { rx: /reddit\.com|redd\.it/, ico: "👽", nombre: "Reddit" }, { rx: /vimeo\.com/, ico: "🎞️", nombre: "Vimeo" },
  { rx: /linkedin\.com/, ico: "💼", nombre: "LinkedIn" }, { rx: /twitch\.tv/, ico: "🎮", nombre: "Twitch" },
  { rx: /soundcloud\.com/, ico: "☁️", nombre: "SoundCloud" }, { rx: /dailymotion\.com|dai\.ly/, ico: "▶️", nombre: "Dailymotion" },
  { rx: /snapchat\.com/, ico: "👻", nombre: "Snapchat" }, { rx: /kwai\.com/, ico: "🎬", nombre: "Kwai" },
];
function redDe(url) {
  let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* enlace raro */ }
  return REDES_UI.find((r) => r.rx.test(host)) || { ico: "🔗", nombre: host || "Enlace" };
}
const MAX_BYTES = 50 * 1024 * 1024;

let usuario = null;
let estado = null;
let nivel = "facil";                       // cada conversación nueva empieza en Fácil
let convActual = null;
let conversaciones = [];
let adjuntos = [];          // {clave, nombre, mime, bytes, ruta, subiendo}
let ocupado = false;
let vistaStream = false;     // ¿el usuario mira la conversación que se está procesando?
let streamNodo = null;
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
  $("u-plan").title = plan === "pro" ? "" : "Pasarte a Simbi Pro";
  $("u-plan").style.cursor = plan === "pro" ? "" : "pointer";
  $("u-plan").onclick = plan === "pro" ? null : () => abrirPro();
  if (plan === "gratis") $("u-plan").textContent = "Gratis · ✨ Pro";
  $("lnk-admin").hidden = estado?.rol !== "admin";
  $("btn-avisos-admin").hidden = estado?.rol !== "admin";
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
  cargarTelegram(); cargarWebsN(); cargarRecsN();
  if (estado?.sin_prueba) abrirCodigo();
  const ultima = leer("simb_conv_" + usuario.id);
  if (ultima && conversaciones.some((c) => c.id === ultima)) abrirConversacion(ultima); else nuevaConversacion();
  cargarMusica();
}

function pintarNiveles() {
  const cont = $("niveles"); cont.textContent = "";
  const permitidos = estado?.limites?.niveles || ["facil"];
  if (!permitidos.includes(nivel)) nivel = permitidos[permitidos.length - 1];
  const actual = NIVELES.find((n) => n.id === nivel) || NIVELES[0];
  const btn = $("nivel-btn"); btn.textContent = "";
  btn.dataset.nivel = actual.id;
  btn.append(barrasNivel(actual.barras), el("span", { class: "nom" }, actual.nombre), el("span", { class: "flecha" }, "▾"));
  btn.title = "Nivel de IA: " + actual.nombre + " — " + actual.desc;
  const menu = $("nivel-menu"); menu.textContent = "";
  menu.append(el("div", { class: "nm-tit" }, "🧠 Nivel de IA para este mensaje"));
  for (const n of NIVELES) {
    const ok = permitidos.includes(n.id);
    menu.append(el("button", { type: "button", role: "option", class: "nm-op", "aria-selected": String(n.id === nivel), "data-nivel": n.id,
      onclick: () => {
        if (!ok) { cerrarMenuNivel(); return abrirPro(`El nivel «${n.nombre}» es parte de la versión Pro.`); }
        nivel = n.id; pintarNiveles(); cerrarMenuNivel(); $("texto").focus();
      } },
      barrasNivel(n.barras),
      el("span", { class: "nm-txt" }, el("b", {}, n.nombre), el("small", {}, n.desc)),
      el("span", { class: "nm-fin" }, ok ? (n.id === nivel ? "✓" : "") : "🔒 Pro")));
  }
  for (const n of NIVELES) {
    const ok = permitidos.includes(n.id);
    cont.append(el("button", { type: "button", role: "radio", "aria-checked": String(n.id === nivel), disabled: !ok,
      title: ok ? "" : "Disponible en la versión Pro",
      onclick: () => { nivel = n.id; pintarNiveles(); } }, ok ? n.nombre : "🔒 " + n.nombre));
  }
}

function cerrarMenuNivel() { $("nivel-menu").hidden = true; $("nivel-btn").setAttribute("aria-expanded", "false"); }
$("nivel-btn").onclick = (e) => {
  e.stopPropagation();
  const m = $("nivel-menu"), abrir = m.hidden;
  if (abrir) {                                    // se ubica sobre el botón sin salirse de la pantalla
    const r = $("nivel-btn").getBoundingClientRect(), angosta = innerWidth < 520;
    m.style.bottom = (innerHeight - r.top + 8) + "px";
    m.style.left = angosta ? "12px" : "auto";
    m.style.right = (angosta ? 12 : Math.max(12, innerWidth - r.right)) + "px";
  }
  m.hidden = !abrir; $("nivel-btn").setAttribute("aria-expanded", String(abrir));
  if (abrir) (m.querySelector('[aria-selected="true"]') || m.querySelector(".nm-op"))?.focus();
};
document.addEventListener("click", (e) => { if (!$("nivel-menu").hidden && !e.target.closest(".nivel-pick")) cerrarMenuNivel(); });
document.addEventListener("keydown", (e) => {
  const m = $("nivel-menu");
  if (m.hidden) return;
  if (e.key === "Escape") { cerrarMenuNivel(); $("nivel-btn").focus(); }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const ops = [...m.querySelectorAll(".nm-op")], i = ops.indexOf(document.activeElement);
    ops[(i + (e.key === "ArrowDown" ? 1 : -1) + ops.length) % ops.length].focus();
  }
});
function campoNivel(sugerido) {
  const permitidos = estado?.limites?.niveles || ["facil"];
  const elegido = sugerido && permitidos.includes(sugerido) ? sugerido : nivel;
  return el("fieldset", { class: "campo-nivel" }, el("legend", {}, "🧠 Nivel de IA"),
    el("div", { class: "cn-grid" }, NIVELES.map((n) => {
      const ok = permitidos.includes(n.id);
      return el("label", { class: "cn-op" + (ok ? "" : " bloq"), title: ok ? n.desc : "Disponible en la versión Pro" },
        el("input", { type: "radio", name: "nivel_ia", value: n.id, disabled: ok ? null : true, checked: n.id === elegido ? true : null }),
        barrasNivel(n.barras), el("b", {}, n.nombre), el("small", {}, ok ? n.desc.split(" · ")[0] : "🔒 Pro"));
    })));
}

function pintarCupos() {
  const c = $("cupos"); c.textContent = "";
  if (!estado) { c.append(el("div", { class: "reinicio" }, "Cargando tus límites…")); return; }
  const L = estado.limites, U = estado.usado;
  const filas = [
    ["Tokens de chat", U.chat_tokens, L.chat_tokens, fmt],
    ["Imágenes", U.imagenes, L.imagenes, fmt],
    ["Videos (3 s)", U.videos, L.videos, fmt],
    ["Voz natural", U.tts_chirp_seg / 60, L.tts_chirp_seg / 60, (x) => `${x.toFixed(0)} min`],
    ["Voz expresiva", U.tts_gemini_seg / 60, L.tts_gemini_seg / 60, (x) => `${x.toFixed(0)} min`],
    ["Transcripción", U.stt_seg / 60, (L.stt_seg || 0) / 60, (x) => `${x.toFixed(0)} min`],
    ["Música", U.musica || 0, L.musica || 0, fmt],
    ["Descargas (YouTube y redes)", U.descargas || 0, L.descargas || 0, fmt],
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
const sinPrueba = () => !!estado?.sin_prueba;
function pintarPrueba() {
  const caja = $("prueba"), nota = $("limites-prueba");
  const t = sinPrueba() ? "🎁 Activa tu día gratis con un código" : textoPrueba();
  caja.hidden = nota.hidden = !t;
  caja.textContent = nota.textContent = t;
  if (pruebaVencida()) caja.textContent += estado?.puede_canjear ? " · Toca aquí si tienes un código" : " · Toca aquí para pasarte a Pro";
  caja.classList.toggle("vencida", pruebaVencida());
  caja.classList.toggle("codigo", sinPrueba());
  caja.style.cursor = sinPrueba() || pruebaVencida() ? "pointer" : "";
}
$("prueba").onclick = () => {
  if (sinPrueba() || (pruebaVencida() && estado?.puede_canjear)) abrirCodigo();
  else if (pruebaVencida()) abrirPro("Tu día de prueba terminó.");
};

/* 🎁 Código de prueba (ej. SOMOS2026) */
function abrirCodigo(msg = "") {
  $("codigo-msg").textContent = msg; $("codigo-txt").value = "";
  $("dlg-codigo").showModal(); $("codigo-txt").focus();
}
$("form-codigo").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const codigo = $("codigo-txt").value.trim();
  if (!codigo) return;
  $("codigo-ok").disabled = true; $("codigo-msg").textContent = "Verificando…";
  const { data, error } = await sb.rpc("canjear_codigo", { p_codigo: codigo });
  $("codigo-ok").disabled = false;
  if (error || data?.error) { $("codigo-msg").textContent = "⚠️ " + (data?.error || "No se pudo verificar. Intenta de nuevo."); return; }
  await cargarEstado();
  $("dlg-codigo").close();
  alert("🎉 ¡Listo! Tu día gratis de Simbi empezó. Tienes 24 horas de chat.");
});

/* ✨ Pasar a Pro: correo + WhatsApp */
const CORREO_PRO = "somossimbioticos@gmail.com";
let motivoPro = "";
function abrirPro(motivo = "") {
  motivoPro = String(motivo || "").slice(0, 200);
  $("pro-motivo").textContent = (motivo ? motivo.replace(/\.?$/, ". ") : "") + "Con Simbi Pro desbloqueas todo:";
  $("pro-mail").href = `mailto:${CORREO_PRO}?subject=${encodeURIComponent("Quiero Simbi Pro")}&body=${encodeURIComponent(
    `Hola, quiero actualizar a Simbi Pro.\nMi cuenta: ${usuario?.email || ""}\nMi WhatsApp: `)}`;
  $("pro-msg").textContent = ""; $("pro-ok").disabled = false;
  if (!$("dlg-pro").open) $("dlg-pro").showModal();
}
$("form-pro").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const wa = $("pro-wa").value.trim();
  if (wa.replace(/\D/g, "").length < 7) { $("pro-msg").textContent = "Escribe tu número de WhatsApp con indicativo (ej. +57 300 123 4567)."; $("pro-wa").focus(); return; }
  $("pro-ok").disabled = true; $("pro-msg").textContent = "Enviando…";
  try {
    await apiNube("/pro/interes", { method: "POST", body: JSON.stringify({ whatsapp: wa, motivo: motivoPro }) });
    $("pro-msg").textContent = "✅ ¡Gracias! Te escribiremos por WhatsApp muy pronto. También puedes escribirnos a " + CORREO_PRO + ".";
    setTimeout(() => $("dlg-pro").open && $("dlg-pro").close(), 4500);
  } catch (err) { $("pro-msg").textContent = "⚠️ " + err.message; $("pro-ok").disabled = false; }
});
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
  { id: "estudio", nombre: "🃏 Tarjetas", es: (m) => m === MIME_TARJETAS },
  { id: "otro", nombre: "📁 Otros", es: (m) => !TIPOS_ARCH.slice(1, 7).some((t) => t.es(m)) },
];
const MIME_TARJETAS = "application/vnd.simbi.tarjetas+json";
function iconoArch(m) {
  return m === MIME_TARJETAS ? "🃏" : /sheet|excel|csv/.test(m) ? "📊" : /word|document/.test(m) ? "📄" : /pdf/.test(m) ? "📕"
    : /presentation/.test(m) ? "📽️" : /zip/.test(m) ? "🗜️" : m.startsWith("audio/") ? "🔊" : m.startsWith("video/") ? "🎬"
    : m.startsWith("image/") ? "🖼️" : /text/.test(m) ? "📝" : "📁";
}

/* URLs firmadas de los archivos del chat (Google Cloud): se piden en lote → menos llamadas y más rapidez */
const urlsCache = new Map();
let loteRutas = null;
function urlRuta(ruta) {
  const c = urlsCache.get(ruta);
  if (c && c.vence > Date.now()) return Promise.resolve(c.url);
  if (!loteRutas) {
    loteRutas = new Map();
    setTimeout(async () => {
      const lote = loteRutas; loteRutas = null;
      const rutas = [...lote.keys()];
      for (let i = 0; i < rutas.length; i += 150) {
        const parte = rutas.slice(i, i + 150);
        let r = {};
        try { r = await apiNube("/archivos/urls", { method: "POST", body: JSON.stringify({ rutas: parte }) }); } catch { /* sin red */ }
        for (const k of parte) {
          const u = r[k] || null;
          if (u) urlsCache.set(k, { url: u, vence: Date.now() + 50 * 60000 });
          lote.get(k).forEach((f) => f(u));
        }
      }
    }, 25);
  }
  return new Promise((ok) => { const l = loteRutas.get(ruta) || []; l.push(ok); loteRutas.set(ruta, l); });
}
async function bajarRuta(ruta, nombre) {
  try {
    const r = await apiNube("/archivos/urls", { method: "POST", body: JSON.stringify({ rutas: [ruta], nombres: { [ruta]: nombre } }) });
    if (!r[ruta]) throw new Error("el archivo ya no está disponible");
    const l = el("a", { href: r[ruta], download: nombre }); document.body.append(l); l.click(); l.remove();
  } catch (e) { alert("No se pudo descargar: " + e.message); }
}

/* ───────── 📲 Avisos por Telegram (@SimbiAlertasBot) ───────── */
const tg = { conectado: false, usuario: "" };
async function cargarTelegram() {
  try { Object.assign(tg, await apiNube("/telegram")); } catch { /* sin conexión */ }
  return tg;
}
async function conectarTelegram() {
  const ventana = window.open("about:blank", "_blank");   // se abre ya para que el navegador no la bloquee
  try {
    const { url } = await apiNube("/telegram/vincular", { method: "POST" });
    if (ventana) ventana.location = url; else location.href = url;
  } catch (e) { ventana?.close(); alert("No se pudo: " + e.message); }
}
async function desconectarTelegram() {
  if (!confirm(`¿Desconectar Telegram${tg.usuario ? " (" + tg.usuario + ")" : ""}? Dejarás de recibir tus avisos.`)) return false;
  try { await apiNube("/telegram", { method: "DELETE" }); tg.conectado = false; return true; } catch (e) { alert(e.message); return false; }
}
window.addEventListener("focus", async () => {                // al volver de Telegram, se actualiza solo
  if (tg.conectado) return;
  await cargarTelegram();
  if (tg.conectado && $("dlg-recs").open) abrirMisRecordatorios();
});

/* ───────── ☁️ Mi nube: TODO en un solo lugar (Google Cloud Storage), con carpetas ───────── */
const nube = { lista: [], carpetas: [], usado: 0, limite: 0, filtro: "todos", carpeta: "", q: "", mostrar: 60, urls: new Map() };
const gb = (b) => b >= 1073741824 * 0.95 ? `${+(b / 1073741824).toFixed(2)} GB` : tam(b);
const ICONO_CARPETA = { "Música": "🎵", "Imágenes": "🖼️", "Videos": "🎬", "Audios": "🔊", "Documentos": "📄", "Estudio": "📚", "Subidos al chat": "📎" };
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
  $("nube-barra").style.background = pct > 90 ? "var(--error)" : "";
  $("nube-resumen").textContent = nube.limite ? `${Math.round(pct)}%` : "";
}
async function cargarNube() {
  const g = $("nube-galeria");
  try {
    const d = await apiNube("/nube");
    Object.assign(nube, { lista: d.archivos, carpetas: d.carpetas || [], usado: d.usado, limite: d.limite });
  } catch (e) { g.textContent = ""; g.append(el("div", { class: "vacio" }, "No se pudo cargar tu nube: " + e.message)); return; }
  pintarCupoNube(); pintarNube();
}
async function abrirNube(carpeta) {
  if (typeof carpeta === "string") { nube.carpeta = carpeta; nube.q = ""; $("nube-buscar").value = ""; }
  nube.filtro = "todos"; nube.mostrar = 60;
  if (!$("dlg-nube").open) $("dlg-nube").showModal();
  const g = $("nube-galeria");
  if (!nube.lista.length) { g.textContent = ""; g.append(el("div", { class: "vacio" }, "Cargando…")); } else pintarNube();
  await cargarNube();
}
const carpetaDe = (a) => a.carpeta || "";
function subcarpetas(c) {
  const pref = c ? c + "/" : "";
  return [...new Set(nube.carpetas.filter((x) => x.startsWith(pref) && x !== c).map((x) => pref + x.slice(pref.length).split("/")[0]))];
}
const contarEn = (c) => nube.lista.filter((a) => carpetaDe(a) === c || carpetaDe(a).startsWith(c + "/")).length;
function irCarpeta(c) { nube.carpeta = c; nube.filtro = "todos"; nube.mostrar = 60; nube.q = ""; $("nube-buscar").value = ""; pintarNube(); }

function pintarNube() {
  const migas = $("nube-migas"); migas.textContent = "";
  const partes = nube.carpeta ? nube.carpeta.split("/") : [];
  migas.append(el("button", { type: "button", onclick: () => irCarpeta("") }, "☁️ Inicio"));
  partes.forEach((p, i) => migas.append(el("span", {}, "›"), el("button", { type: "button", onclick: () => irCarpeta(partes.slice(0, i + 1).join("/")) }, p)));
  $("nube-quitar").hidden = !nube.carpeta;
  const q = nube.q.trim().toLowerCase();
  const base = q ? nube.lista.filter((a) => a.nombre.toLowerCase().includes(q) || carpetaDe(a).toLowerCase().includes(q))
                 : nube.lista.filter((a) => carpetaDe(a) === nube.carpeta);
  const f = $("nube-filtros"); f.textContent = "";
  f.hidden = !base.length;
  for (const t of TIPOS_ARCH) {
    const n = base.filter((a) => t.es(a.mime)).length;
    if (t.id !== "todos" && !n) continue;
    f.append(el("button", { type: "button", role: "tab", "aria-selected": String(nube.filtro === t.id),
      onclick: () => { nube.filtro = t.id; nube.mostrar = 60; pintarNube(); } }, t.nombre, el("small", {}, String(n))));
  }
  const tipo = TIPOS_ARCH.find((t) => t.id === nube.filtro) || TIPOS_ARCH[0];
  const todos = base.filter((a) => tipo.es(a.mime));
  const lista = todos.slice(0, nube.mostrar);
  $("nube-mas").hidden = todos.length <= nube.mostrar;
  const g = $("nube-galeria"); g.textContent = "";
  if (!nube.limite && !nube.lista.length) {
    g.append(el("div", { class: "vacio" }, "«Mi nube» está disponible en la versión Pro (5 GB).",
      el("div", {}, el("button", { type: "button", class: "btn btn-brasa btn-pro", onclick: () => abrirPro("«Mi nube» es parte de la versión Pro.") }, "✨ Quiero Pro"))));
    return;
  }
  if (!q && nube.filtro === "todos") for (const c of subcarpetas(nube.carpeta)) {
    const nombre = c.split("/").pop();
    g.append(el("div", { class: "item-arch carpeta", role: "button", tabindex: "0", onclick: () => irCarpeta(c), onkeydown: (e) => e.key === "Enter" && irCarpeta(c) },
      el("div", { class: "vista" }, ICONO_CARPETA[c] || "📁"), el("div", { class: "info" }, el("b", { title: c }, nombre), el("small", {}, `${contarEn(c)} archivos`))));
  }
  if (!lista.length && !g.childElementCount) {
    g.append(el("div", { class: "vacio" }, q ? "No encontré archivos con ese nombre." : nube.carpeta ? "Esta carpeta está vacía. Arrastra archivos aquí o usa «Subir»." : "Tu nube está vacía. Sube fotos, videos o documentos para guardarlos aquí."));
    return;
  }
  const tarjetas = lista.map((a) => {
    const vista = el("div", { class: "vista" }, iconoArch(a.mime));
    const acc = el("div", { class: "acc" });
    const fecha = new Date(a.creado).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
    if (a.mime === MIME_TARJETAS) acc.append(el("button", { type: "button", class: "mini", onclick: () => abrirTarjetas(a.ruta, a.nombre) }, "🃏 Repasar"));
    acc.append(
      el("button", { type: "button", class: "mini", title: "Descargar", onclick: () => bajarNube(a) }, "⬇"),
      el("button", { type: "button", class: "mini", title: "Mover a otra carpeta", onclick: () => moverNube([a]) }, "📁"),
      el("button", { type: "button", class: "mini", title: "Renombrar", onclick: () => renombrarNube(a) }, "✏️"),
      a.conversacion_id ? el("button", { type: "button", class: "mini", title: "Ver la conversación donde se creó", onclick: () => { $("dlg-nube").close(); abrirConversacion(a.conversacion_id); } }, "💬") : null,
      el("button", { type: "button", class: "mini peligro", title: "Borrar", onclick: () => borrarNube(a) }, "🗑"));
    g.append(el("div", { class: "item-arch" }, vista, el("div", { class: "info" }, el("b", { title: a.nombre }, a.nombre.replace(/\.tarjetas\.json$/, "")),
      el("small", {}, `${fecha} · ${gb(a.bytes)}`), q && carpetaDe(a) ? el("small", { class: "ruta-arch" }, "📁 " + carpetaDe(a)) : null, acc)));
    return { a, vista };
  });
  const conVista = tarjetas.filter(({ a }) => /^(image|video|audio)\//.test(a.mime));
  const faltan = conVista.filter(({ a }) => !nube.urls.has(a.id)).map(({ a }) => a.id);
  const lotes = []; for (let i = 0; i < faltan.length; i += 100) lotes.push(faltan.slice(i, i + 100));
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
  for (const { a, vista } of tarjetas) if (!/^(image|video|audio)\//.test(a.mime)) vista.onclick = () => a.mime === MIME_TARJETAS ? abrirTarjetas(a.ruta, a.nombre) : abrirEnPestana(a);
}
$("nube-mas").onclick = () => { nube.mostrar += 60; pintarNube(); };
$("nube-buscar").addEventListener("input", (e) => { nube.q = e.target.value; nube.mostrar = 60; pintarNube(); });
$("nube-nueva").onclick = () => abrirDialogo("Nueva carpeta", [
  el("label", {}, nube.carpeta ? `Nombre (dentro de «${nube.carpeta}»)` : "Nombre", el("input", { type: "text", name: "nombre", required: true, maxlength: 60, placeholder: "Ej.: Universidad, Fotos de la familia, Trabajo" })),
], "", "Crear", async (f) => {
  const nombre = (nube.carpeta ? nube.carpeta + "/" : "") + f.get("nombre").trim().replace(/\//g, "-");
  try { const r = await apiNube("/nube/carpeta", { method: "POST", body: JSON.stringify({ nombre }) }); await cargarNube(); irCarpeta(r.nombre); }
  catch (e) { alert(e.message); }
});
$("nube-quitar").onclick = async () => {
  const c = nube.carpeta; if (!c) return;
  if (!confirm(`¿Quitar la carpeta «${c}»?\nSus archivos NO se borran: pasan a la carpeta de arriba.`)) return;
  try { await apiNube("/nube/carpeta/borrar", { method: "POST", body: JSON.stringify({ nombre: c }) }); } catch (e) { alert(e.message); return; }
  irCarpeta(c.includes("/") ? c.slice(0, c.lastIndexOf("/")) : ""); await cargarNube();
};
function moverNube(archivos) {
  const sel = el("select", { name: "destino" }, el("option", { value: "" }, "☁️ Inicio (sin carpeta)"),
    nube.carpetas.map((c) => el("option", { value: c, selected: c === carpetaDe(archivos[0]) ? true : null }, "📁 " + c)));
  abrirDialogo("Mover a carpeta", [el("label", {}, "Carpeta", sel),
    el("label", {}, "…o crea una nueva", el("input", { type: "text", name: "nueva", maxlength: 120, placeholder: "Ej.: Universidad/Anatomía" }))],
  archivos.length === 1 ? archivos[0].nombre : `${archivos.length} archivos`, "Mover", async (f) => {
    const carpeta = (f.get("nueva") || "").trim() || f.get("destino") || "";
    try { await apiNube("/nube/mover", { method: "POST", body: JSON.stringify({ ids: archivos.map((a) => a.id), carpeta }) }); await cargarNube(); }
    catch (e) { alert(e.message); }
  });
}
function renombrarNube(a) {
  abrirDialogo("Renombrar", [el("label", {}, "Nuevo nombre", el("input", { type: "text", name: "nombre", required: true, maxlength: 180, value: a.nombre }))],
    "", "Guardar", async (f) => {
      const nombre = f.get("nombre").trim();
      try { await apiNube(`/nube/${a.id}/renombrar`, { method: "POST", body: JSON.stringify({ nombre }) }); a.nombre = nombre; pintarNube(); }
      catch (e) { alert(e.message); }
    });
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
  if (!confirm(`¿Borrar «${a.nombre}»? No se puede deshacer.`)) return;
  try { await apiNube("/nube/" + a.id, { method: "DELETE" }); } catch (e) { alert(e.message); return; }
  nube.lista = nube.lista.filter((x) => x.id !== a.id); nube.usado -= a.bytes; nube.urls.delete(a.id);
  pintarCupoNube(); pintarNube();
  if ((a.mime || "").startsWith("audio/")) cargarMusica();
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
      const r = await apiNube("/nube/subir", { method: "POST", body: JSON.stringify({ nombre: archivo.name, mime: mimeDe(archivo), bytes: archivo.size, carpeta: nube.carpeta }) });
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
    const deYoutube = (m.eventos || []).some((e) => e.nombre === "descargar_youtube" || e.nombre === "descargar_redes");
    return (m.adjuntos || []).filter((a) => (a.mime || "").startsWith("audio/") && a.ruta && !vistos.has(a.ruta) && vistos.add(a.ruta))
      .map((a) => ({ ...a, titulo: tituloCancion(a.nombre), youtube: (deYoutube || /^musica_/.test(a.nombre)) && !/^voz_/.test(a.nombre), creado: m.creado }));
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
    const u = await urlRuta(c.ruta);
    if (!u) { c.roto = true; return tocar(musica.i + 1); }
    c.url = u; c.vence = Date.now() + 50 * 60 * 1000;
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
      "Aún no tienes música. Usa «⬇️ Descargar de YouTube» o «📲 Descargar de redes» → «Solo audio MP3» (puedes pegar varios enlaces)."));
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
  vistaStream = false;
  convActual = null; guardar("simb_conv_" + usuario.id, "");
  nivel = "facil"; pintarNiveles();
  $("titulo-conv").textContent = "Nueva conversación";
  $("mensajes").textContent = ""; $("mensajes").append(bienvenida);
  pintarLista(); cerrarLateral(); $("texto").focus();
}
$("btn-nuevo").onclick = nuevaConversacion;

async function abrirConversacion(id) {
  vistaStream = ocupado && id === convProcesando;
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
      for (const ev of m.eventos || []) ev.url ? v.sitio(ev) : v.evento({ ...ev, t: "herramienta" });
      for (const a of m.adjuntos || []) v.archivo(a);
      v.texto = m.contenido; v.pintar(true);
      v.pie(m.nivel, m.tokens, modelos?.get(m.id));
    }
  }
  if (vistaStream && streamNodo) cont.append(streamNodo);      // la respuesta en curso sigue viva
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
  const cont0 = cont;
  cont.append(nodo);
  const chips = new Map();
  let pendiente = false;
  const v = {
    nodo,
    texto: "",
    pintar(final = false) {
      pensando.remove();
      renderMd(md, v.texto || "");
      md.classList.toggle("cursor", !final);
      if (!nodo.isConnected) return;                    // el usuario está viendo otra conversación
      const cerca = cont0.scrollHeight - cont0.scrollTop - cont0.clientHeight < 160;
      if (cerca) cont0.scrollTop = cont0.scrollHeight;
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
    sitio(w) { pensando.remove(); archivos.append(tarjetaSitio(w)); },
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
  const bajar = (txt = "⬇ Descargar") => el("a", { href: "#", onclick: (e) => { e.preventDefault(); bajarRuta(a.ruta, a.nombre); } }, txt);
  if (mime === MIME_TARJETAS) {
    caja.append(el("div", { class: "tarjeta-arch" }, el("span", { class: "ico" }, "🃏"),
      el("div", { class: "meta" }, el("b", {}, a.nombre.replace(/\.tarjetas\.json$/, "").replace(/_/g, " ")), el("small", {}, "Tarjetas de estudio · guardadas en ☁️ Mi nube › Estudio")),
      el("button", { type: "button", class: "btn btn-brasa btn-chico btn-repasar", onclick: () => abrirTarjetas(a.ruta, a.nombre) }, "Repasar")));
    return caja;
  }
  urlRuta(a.ruta).then((url) => {
    if (!url) { caja.append(el("div", { class: "tarjeta-arch" }, el("span", { class: "ico" }, "⚠️"), el("div", { class: "meta" }, el("b", {}, a.nombre), el("small", {}, "El archivo ya no está disponible")))); return; }
    const acc = el("div", { class: "archivo-acc" }, bajar(), el("span", { class: "mono", style: "font-size:10.5px" }, a.nombre + " · " + tam(a.bytes || 0)));
    if (mime.startsWith("image/")) {
      const img = el("img", { src: url, alt: a.nombre, loading: "lazy" });
      img.onclick = () => { const v = el("div", { class: "visor", onclick: () => v.remove() }, el("img", { src: url, alt: a.nombre })); document.body.append(v); };
      caja.append(el("div", { class: "archivo-img" }, img), acc);
    } else if (mime.startsWith("video/")) {
      caja.append(el("div", { class: "archivo-vid" }, el("video", { src: url, controls: true, playsinline: true, preload: "metadata" })), acc);
    } else if (mime.startsWith("audio/")) {
      caja.append(el("div", { class: "archivo-aud" }, el("audio", { src: url, controls: true, preload: "metadata" })), acc);
    } else {
      caja.append(el("div", { class: "tarjeta-arch" }, el("span", { class: "ico" }, iconoArch(mime)),
        el("div", { class: "meta" }, el("b", {}, a.nombre), el("small", {}, tam(a.bytes || 0))), bajar("Descargar")));
    }
  });
  return caja;
}

/* ───────── 🃏 Repasar tarjetas de estudio (tipo Anki: cajas de Leitner guardadas en este navegador) ───────── */
const tj = { mazo: null, clave: "", cajas: {}, cola: [], actual: null, volteada: false, hechas: 0, total: 0 };
async function abrirTarjetas(ruta, nombre) {
  const dlg = $("dlg-tarjetas");
  $("tj-titulo").textContent = (nombre || "Tarjetas").replace(/\.tarjetas\.json$/, "").replace(/_/g, " ");
  $("tj-texto").textContent = "Cargando…"; $("tj-botones").hidden = true; $("tj-cont").textContent = ""; $("tj-pista").textContent = "";
  tj.actual = null; tj.mazo = null;
  if (!dlg.open) dlg.showModal();
  try {
    const url = await urlRuta(ruta);
    if (!url) throw new Error("el archivo ya no está disponible");
    const r = await fetch(url); if (!r.ok) throw new Error("Error " + r.status);
    tj.mazo = await r.json();
    if (!Array.isArray(tj.mazo?.tarjetas) || !tj.mazo.tarjetas.length) throw new Error("el mazo está vacío");
  } catch (e) { $("tj-texto").textContent = "No se pudo abrir: " + e.message; tj.mazo = null; return; }
  $("tj-titulo").textContent = tj.mazo.titulo || $("tj-titulo").textContent;
  tj.clave = "simb_tj_" + ruta;
  try { tj.cajas = JSON.parse(leer(tj.clave) || "{}"); } catch { tj.cajas = {}; }
  iniciarRepaso();
}
function iniciarRepaso() {
  const n = tj.mazo.tarjetas.length;
  tj.cola = [...Array(n).keys()].sort(() => Math.random() - .5).sort((a, b) => (tj.cajas[a] || 0) - (tj.cajas[b] || 0));
  tj.hechas = 0; tj.total = n;
  siguienteTarjeta();
}
function siguienteTarjeta() {
  const carta = $("tj-carta");
  $("tj-barra").style.width = (tj.total ? tj.hechas / tj.total * 100 : 0) + "%";
  $("tj-cont").textContent = `${tj.hechas} de ${tj.total} · dominadas: ${Object.values(tj.cajas).filter((c) => c >= 3).length}`;
  if (!tj.cola.length) {
    tj.actual = null; carta.classList.add("volteada");
    $("tj-cara").textContent = "¡Terminaste! 🎉";
    renderMd($("tj-texto"), `Repasaste las **${tj.total}** tarjetas.\n\nToca aquí para repasar de nuevo (primero salen las que más te cuestan).`);
    $("tj-pista").textContent = ""; $("tj-botones").hidden = true; $("tj-nota").textContent = "Tu progreso queda guardado en este dispositivo."; return;
  }
  tj.actual = tj.cola.shift(); tj.volteada = false; carta.classList.remove("volteada");
  const t = tj.mazo.tarjetas[tj.actual];
  $("tj-cara").textContent = "Pregunta"; renderMd($("tj-texto"), String(t.frente || ""));
  $("tj-pista").textContent = t.pista ? "💡 " + t.pista : ""; $("tj-botones").hidden = true;
  $("tj-nota").textContent = "Toca la tarjeta (o la barra espaciadora) para ver la respuesta.";
}
function voltearTarjeta() {
  if (!tj.mazo) return;
  if (tj.actual === null) { iniciarRepaso(); return; }
  if (tj.volteada) return;
  tj.volteada = true; $("tj-carta").classList.add("volteada");
  $("tj-cara").textContent = "Respuesta"; renderMd($("tj-texto"), String(tj.mazo.tarjetas[tj.actual].reverso || ""));
  $("tj-pista").textContent = ""; $("tj-botones").hidden = false; $("tj-nota").textContent = "¿Qué tal te fue? (teclas 1-4)";
}
function calificarTarjeta(r) {
  if (tj.actual === null || !tj.volteada) return;
  const i = tj.actual, caja = tj.cajas[i] || 0;
  if (r === 0) { tj.cajas[i] = 0; tj.cola.splice(Math.min(3, tj.cola.length), 0, i); }
  else if (r === 1) { tj.cajas[i] = caja; tj.cola.push(i); }
  else { tj.cajas[i] = caja + (r === 3 ? 2 : 1); tj.hechas++; }
  guardar(tj.clave, JSON.stringify(tj.cajas));
  siguienteTarjeta();
}
$("tj-carta").onclick = voltearTarjeta;
$("tj-botones").onclick = (e) => { const b = e.target.closest("[data-r]"); if (b) calificarTarjeta(+b.dataset.r); };
$("dlg-tarjetas").addEventListener("keydown", (e) => {
  if (e.target.closest("button.btn-x")) return;
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); voltearTarjeta(); }
  else if (tj.volteada && ["1", "2", "3", "4"].includes(e.key)) calificarTarjeta(+e.key - 1);
});

/* ───────── 🌐 Webs creadas por Simbi ───────── */
async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); alert("🔗 Enlace copiado"); } catch { prompt("Copia el enlace:", texto); }
}
function tarjetaSitio(w) {
  return el("div", { class: "sitio-card" }, el("span", { class: "ico" }, "🌐"),
    el("div", { class: "meta" }, el("b", {}, w.titulo || "Tu página web"), el("small", {}, w.url)),
    el("a", { class: "btn btn-brasa btn-chico", href: w.url, target: "_blank", rel: "noopener" }, "Abrir"),
    el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: () => copiar(w.url) }, "Copiar enlace"),
    el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: () => abrirWebs() }, "Mis webs"));
}
async function cargarWebsN() {
  try { const d = await apiNube("/sitios"); $("webs-n").textContent = d.sitios.length ? String(d.sitios.length) : ""; return d.sitios; }
  catch { return []; }
}
/* 🔌 Conexiones propias: GitHub (publicar en tu usuario.github.io) y Supabase (base de datos de tus webs) */
function cajaConexiones(cx, alCambiar) {
  const caja = el("div", { class: "conexiones" });
  const guardarToken = async (servicio, input, boton) => {
    const token = input.value.trim(); if (!token) return input.focus();
    boton.disabled = true; boton.textContent = "Verificando…";
    try { await apiNube("/conexiones/" + servicio, { method: "POST", body: JSON.stringify({ token }) }); input.value = ""; alCambiar(); }
    catch (e) { alert(e.message); boton.disabled = false; boton.textContent = "Guardar"; }
  };
  const desconectar = async (servicio) => {
    if (!confirm("¿Desconectar? El token se borra de Simbi. (Tus webs ya publicadas siguen funcionando.)")) return;
    try { await apiNube("/conexiones/" + servicio, { method: "DELETE" }); alCambiar(); } catch (e) { alert(e.message); }
  };
  const formulario = (servicio, ph, ayuda) => {
    const input = el("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: ph, "data-servicio": servicio });
    const boton = el("button", { type: "button", class: "btn btn-brasa btn-chico" }, "Guardar");
    boton.onclick = () => guardarToken(servicio, input, boton);
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); boton.click(); } };
    return [el("div", { class: "con-fila" }, input, boton), el("details", {}, el("summary", {}, "¿Cómo lo consigo?"), el("ol", {}, ayuda.map((x) => el("li", {}, ...x))))];
  };
  const enlace = (href, t) => el("a", { href, target: "_blank", rel: "noopener" }, t);
  // GitHub
  const g = cx.github;
  caja.append(el("div", { class: "con-tarj" + (g.conectado ? " ok" : "") },
    el("b", {}, "🐙 GitHub · dónde se publica tu web"),
    g.conectado
      ? [el("span", {}, "✅ Conectado como ", el("b", {}, "@" + g.login), ` (token …${g.pista}). Tus webs quedan en `, enlace(g.sitio, g.sitio + "nombre-de-la-web/")),
         el("div", { class: "con-fila" }, el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: () => desconectar("github") }, "Desconectar"))]
      : [el("span", { class: "nota" }, "Sin conectar: tus webs se publican en Google Cloud (storage.googleapis.com/…). Con GitHub quedan en ", el("b", {}, "tuusuario.github.io/nombre-de-la-web/"), "."),
         ...formulario("github", "ghp_… o github_pat_…", [
           ["Entra a ", enlace("https://github.com/settings/tokens/new?description=Simbi&scopes=public_repo", "github.com/settings/tokens/new"), " (ya viene configurado)."],
           ["Deja marcado ", el("b", {}, "public_repo"), ", elige la expiración y toca ", el("b", {}, "Generate token"), "."],
           ["Copia el token (empieza por ghp_) y pégalo aquí."]])]));
  // Supabase
  const b = cx.supabase;
  const selProy = b.conectado && b.proyectos.length ? el("select", {}, el("option", { value: "" }, "Elige el proyecto…"),
    b.proyectos.map((p) => el("option", { value: p.ref, selected: p.ref === b.ref ? true : null }, `${p.nombre} (${p.region || ""})`))) : null;
  if (selProy) selProy.onchange = async () => {
    if (!selProy.value) return;
    try { await apiNube("/conexiones/supabase/proyecto", { method: "POST", body: JSON.stringify({ ref: selProy.value }) }); alCambiar(); } catch (e) { alert(e.message); }
  };
  caja.append(el("div", { class: "con-tarj" + (b.conectado && b.ref ? " ok" : "") },
    el("b", {}, "🗄️ Supabase · base de datos de tus webs (formularios, registros, pedidos…)"),
    b.conectado
      ? [el("span", {}, b.ref ? `✅ Conectado (token …${b.pista}). Los datos se guardan en tu proyecto «${b.proyecto}».` : `⚠️ Token guardado (…${b.pista}). Elige el proyecto donde se crearán las tablas:`),
         el("div", { class: "con-fila" }, selProy,
           b.proyectos.length < 2 ? el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: async (e) => {
             if (!confirm("¿Crear un proyecto nuevo «simbi-webs» en tu cuenta de Supabase (plan gratis)?")) return;
             e.target.disabled = true;
             try { const r = await apiNube("/conexiones/supabase/crear", { method: "POST" }); alert(r.nota); alCambiar(); } catch (er) { alert(er.message); e.target.disabled = false; }
           } }, "＋ Crear proyecto simbi-webs") : null,
           el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: () => desconectar("supabase") }, "Desconectar"))]
      : [el("span", { class: "nota" }, "Necesario solo si tu web guarda información. Cada web tiene sus propias tablas en TU Supabase."),
         ...formulario("supabase", "sbp_…", [
           ["Entra a ", enlace("https://supabase.com/dashboard/account/tokens", "supabase.com/dashboard/account/tokens"), " (crea tu cuenta gratis si no tienes)."],
           ["Toca ", el("b", {}, "Generate new token"), ", ponle de nombre Simbi y cópialo (empieza por sbp_)."],
           ["Pégalo aquí y elige el proyecto (o crea uno con un clic)."]])]));
  caja.append(el("small", { class: "nota" }, "🔒 Tus tokens se guardan cifrados (AES-256, con la llave en Google Secret Manager) y nunca se vuelven a mostrar. Puedes desconectarlos cuando quieras."));
  return caja;
}

async function abrirWebs() {
  const dlg = $("dlg-webs"), c = $("webs-cont");
  if (!dlg.open) dlg.showModal();
  c.textContent = ""; c.append(el("div", { class: "vacio" }, "Cargando…"));
  const lista = await cargarWebsN();
  c.textContent = "";
  if (!lista.length) {
    c.append(el("div", { class: "vacio" }, esPro() ? "Aún no tienes webs. Pídele a Simbi: «crea una página web para mi negocio con formulario de contacto»."
      : "Crear y publicar páginas web es parte de la versión Pro.",
      esPro() ? el("div", {}, el("button", { type: "button", class: "btn btn-brasa btn-chico", onclick: () => { dlg.close(); abrirAtajo("web"); } }, "🌐 Crear mi primera web"))
        : el("div", {}, el("button", { type: "button", class: "btn btn-brasa btn-pro", onclick: () => abrirPro("Las páginas web son parte de la versión Pro.") }, "✨ Quiero Pro"))));
    return;
  }
  for (const w of lista) {
    const zona = el("div");
    const cols = el("div", { class: "cols" }, w.colecciones.map((col) => el("button", { type: "button", onclick: () => verDatosWeb(w, col.nombre, zona) },
      `${col.privada ? "🔐" : "📋"} ${col.nombre} (${w.conteo?.[col.nombre] ?? 0})${col.privada ? " · con inicio de sesión" : col.publico_leer ? " · pública" : ""}`)));
    c.append(el("div", { class: "web-tarj" },
      el("div", { class: "cab" }, el("b", {}, w.titulo),
        el("a", { class: "btn btn-brasa btn-chico", href: w.url, target: "_blank", rel: "noopener" }, "Abrir"),
        el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: () => copiar(w.url) }, "Copiar enlace"),
        w.conversacion_id ? el("button", { type: "button", class: "btn btn-borde btn-chico", title: "Pídele cambios a Simbi en esta conversación", onclick: () => { $("dlg-webs").close(); abrirConversacion(w.conversacion_id); } }, "✏️ Editar") : null,
        el("button", { type: "button", class: "btn-x", title: "Borrar la web y sus datos", onclick: async () => {
          if (!confirm(`¿Borrar «${w.titulo}»? El enlace dejará de funcionar y se borran sus datos.`)) return;
          try { await apiNube("/sitios/" + w.id, { method: "DELETE" }); abrirWebs(); } catch (e) { alert(e.message); }
        } }, "🗑")),
      el("span", { class: "url" }, (w.hosting === "github" ? "GitHub · " : "Google Cloud · ") + w.url),
      w.url_respaldo ? el("small", { class: "nota" }, "Copia en Google Cloud: ",
        el("a", { href: w.url_respaldo, target: "_blank", rel: "noopener" }, "abrir"), " · ",
        el("button", { type: "button", class: "enlace", onclick: () => copiar(w.url_respaldo) }, "copiar enlace")) : null,
      el("small", { class: "nota" }, `Actualizada ${new Date(w.actualizado).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${w.archivos} archivos`),
      w.colecciones.length ? cols : el("small", { class: "nota" }, "Sin base de datos (pídele a Simbi un formulario si la necesitas)."),
      zona));
  }
}
async function verDatosWeb(w, col, zona) {
  zona.textContent = "Cargando…";
  let filas;
  try { filas = (await apiNube(`/sitios/${w.id}/datos?coleccion=${encodeURIComponent(col)}`)).datos; } catch (e) { zona.textContent = e.message; return; }
  zona.textContent = "";
  if (!filas.length) { zona.append(el("small", { class: "nota" }, `«${col}» aún no tiene datos.`)); return; }
  const claves = [...new Set(filas.flatMap((f) => Object.keys(f.datos || {})))].slice(0, 12);
  const texto = (v) => typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");
  const csv = () => {
    const esc = (v) => `"${texto(v).replace(/"/g, '""')}"`;
    const lineas = [["fecha", ...claves].map(esc).join(","), ...filas.map((f) => [new Date(f.creado).toLocaleString("es-CO"), ...claves.map((k) => f.datos?.[k])].map(esc).join(","))];
    const a = el("a", { href: URL.createObjectURL(new Blob(["\ufeff" + lineas.join("\n")], { type: "text/csv" })), download: `${col}.csv` });
    document.body.append(a); a.click(); a.remove();
  };
  zona.append(el("div", { class: "cab" }, el("b", {}, `📋 ${col} · ${filas.length}`), el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: csv }, "⬇ Excel/CSV")),
    el("div", { class: "tabla-datos" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Fecha"), claves.map((k) => el("th", {}, k)), el("th", {}, ""))),
      el("tbody", {}, filas.map((f) => {
        const tr = el("tr", {}, el("td", {}, new Date(f.creado).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })),
          claves.map((k) => el("td", {}, texto(f.datos?.[k]))),
          el("td", {}, el("button", { type: "button", class: "btn-x", title: "Borrar", onclick: async () => {
            if (!confirm("¿Borrar este registro?")) return;
            try { await apiNube(`/sitios/${w.id}/datos/${f.id}?coleccion=${encodeURIComponent(col)}`, { method: "DELETE" }); tr.remove(); } catch (e) { alert(e.message); }
          } }, "✕")));
        return tr;
      })))));
}
$("btn-webs").onclick = () => abrirWebs();

/* ───────── Envío y streaming ───────── */
async function enviar({ mensaje = "", accion = null, params = {} } = {}) {
  if (ocupado) { alert("Simbi está terminando otra respuesta. Mientras tanto puedes mirar otros chats; cuando termine podrás enviar este."); return; }
  if (!API_LISTA) { alert("Simbi se está terminando de instalar. Intenta de nuevo pronto."); return; }
  if (sinPrueba()) { abrirCodigo(); return; }
  if (pruebaVencida()) { pintarPrueba(); estado?.puede_canjear ? abrirCodigo("Tu día de prueba terminó. Si tienes otro código, escríbelo aquí.") : abrirPro("Tu día de prueba terminó."); return; }
  if (adjuntos.some((a) => a.subiendo)) { alert("Espera a que terminen de subir los archivos."); return; }
  const adj = adjuntos.map(({ ruta, nombre, mime, bytes }) => ({ ruta, nombre, mime, bytes }));
  if (!mensaje.trim() && !accion && !adj.length) return;

  ocupado = true; alternarEnvio(true);
  convProcesando = convActual || "nueva"; pintarLista();
  pintarUsuario(mensaje || etiquetaAccion(accion, params), adj);
  $("texto").value = ""; adjuntos = []; pintarAdjuntos(); contar(); sugerir();
  vistaStream = true;
  const v = nuevaRespuesta();
  streamNodo = v.nodo;
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
    convProcesando = null; streamNodo = null; vistaStream = false; pintarLista();
  }
}

function manejar(ev, v) {
  switch (ev.t) {
    case "conv":
      if (ocupado) convProcesando = ev.id;
      if (!conversaciones.some((c) => c.id === ev.id)) conversaciones.unshift({ id: ev.id, titulo: ev.titulo, actualizado: new Date().toISOString() });
      if (vistaStream && convActual !== ev.id) { convActual = ev.id; guardar("simb_conv_" + usuario.id, ev.id); $("titulo-conv").textContent = ev.titulo; }
      pintarLista();
      break;
    case "texto": v.agregar(ev.d); break;
    case "herramienta": v.evento(ev); break;
    case "progreso": v.progreso(ev.msg); break;
    case "archivo": v.archivo(ev); break;
    case "sitio": v.sitio(ev); cargarWebsN(); break;
    case "error": v.error(ev.msg); if (ev.pro) abrirPro(ev.motivo ? `Quisiste usar: ${ev.motivo}.` : ""); if (ev.codigo) abrirCodigo(); break;
    case "fin":
      convProcesandoUltima = convProcesando;
      v.pintar(true); v.pie(ev.nivel, ev.tokens, ev.modelo);
      if (ev.estado) { estado = ev.estado; pintarCupos(); contar(); }
      if (v.texto.includes("Mi música") || v.texto.startsWith("✅ Listo")) cargarMusica();
      const c = conversaciones.find((x) => x.id === convProcesando);
      if (!vistaStream) avisoListo(c?.titulo);
      if (c) { c.actualizado = new Date().toISOString(); conversaciones = [c, ...conversaciones.filter((x) => x !== c)]; pintarLista(); }
      break;
  }
}

let convProcesandoUltima = null;
function avisoListo(titulo) {
  const t = el("button", { type: "button", class: "toast-listo", onclick: () => { t.remove(); if (convProcesandoUltima) abrirConversacion(convProcesandoUltima); } },
    "✅ Simbi terminó «" + (titulo || "tu respuesta") + "» · Ver");
  document.body.append(t); setTimeout(() => t.remove(), 10000);
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
  const red = !yt && enlacesRedes($("texto").value)[0];
  if (red) {
    caja.append(el("button", { type: "button", onclick: () => enviar({ accion: "redes_mp4", params: { url: red } }) }, `📲 Descargar de ${redDe(red).nombre}`),
      el("button", { type: "button", onclick: () => enviar({ accion: "redes_mp3", params: { url: red } }) }, "🎵 Solo audio MP3"));
  }
  const medio = adjuntos.find((a) => !a.subiendo && /^(audio|video)\//.test(a.mime));
  if (medio) caja.append(el("button", { type: "button", onclick: () => enviar({ accion: "transcribir", params: { archivo: medio.nombre } }) }, "📝 Transcribir " + medio.nombre));
  const img = adjuntos.find((a) => !a.subiendo && a.mime.startsWith("image/"));
  if (img) caja.append(el("button", { type: "button", onclick: () => abrirAtajo("imagen", true) }, "🎨 Editar esta imagen con IA"));
  caja.hidden = !caja.childElementCount;
}

/* ───────── Adjuntos ───────── */
$("btn-adjuntar").onclick = () => { if (!esPro()) return abrirPro("Subir archivos es parte de la versión Pro."); $("archivo").accept = ""; $("archivo").click(); };
$("archivo").onchange = async (e) => { await subirArchivos([...e.target.files]); e.target.value = ""; };
document.addEventListener("dragover", (e) => { if (esPro()) e.preventDefault(); });
document.addEventListener("drop", (e) => { if (!esPro() || !e.dataTransfer?.files?.length) return; e.preventDefault(); subirArchivos([...e.dataTransfer.files]); });
document.addEventListener("paste", (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length && esPro()) subirArchivos(fs); });

async function subirArchivos(lista) {
  const subidos = [];
  for (const f of lista) {
    if (f.size > MAX_BYTES) { alert(`"${f.name}" supera 50 MB. Para archivos grandes usa ☁️ Mi nube.`); continue; }
    const a = { clave: crypto.randomUUID(), nombre: f.name, mime: mimeDe(f), bytes: f.size, subiendo: true };
    adjuntos.push(a); pintarAdjuntos();
    subidos.push((async () => {
      try {
        const r = await apiNube("/archivos/subir", { method: "POST", body: JSON.stringify({ nombre: f.name, mime: a.mime, bytes: f.size }) });
        await putConProgreso(r.url, f, r.encabezados, () => {});
        await apiNube(`/nube/${r.id}/listo`, { method: "POST" });
        Object.assign(a, { ruta: r.ruta, nombre: r.nombre, mime: r.mime, subiendo: false });
        pintarAdjuntos(); sugerir(); return a;
      } catch (e) {
        alert(`No se pudo subir "${f.name}": ${e.message}`);
        adjuntos = adjuntos.filter((x) => x !== a); pintarAdjuntos(); return null;
      }
    })());
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
// Herramientas del inicio, agrupadas por categoría (g). nuevo = muestra la etiqueta «NUEVO».
const GRUPOS = [
  ["crear", "🎨", "Crear con IA"],
  ["editar", "🖼️", "Fotos y video"],
  ["docs", "📄", "Documentos"],
  ["descargas", "⬇️", "Descargas"],
  ["mas", "🌐", "Web y avisos"],
];
const ATAJOS = [
  { id: "imagen", g: "crear", ico: "🎨", titulo: "Crear una imagen", desc: "Describe lo que imaginas", pro: true },
  { id: "video", g: "crear", ico: "🎬", titulo: "Video con IA", desc: "Clip de 3 a 8 segundos (Veo)", pro: true },
  { id: "musica", g: "crear", ico: "🎵", titulo: "Crear música", desc: "Pista instrumental original de ~30 s", pro: true },
  { id: "voz", g: "crear", ico: "🔊", titulo: "Texto a voz", desc: "Voz natural o voz expresiva", pro: true },
  { id: "video_codigo", g: "crear", ico: "🎞️", titulo: "Video con código", desc: "Animación con Python + voz natural o expresiva", pro: true },
  { id: "foto", g: "editar", ico: "🖼️", titulo: "Mejorar foto", desc: "Quitar fondo, mejorar, restaurar, colorear o retrato pro", pro: true },
  { id: "producto", g: "editar", ico: "🛍️", titulo: "Foto de producto pro", desc: "De foto de celular a foto de catálogo", pro: true },
  { id: "subtitulos", g: "editar", ico: "✂️", titulo: "Subtítulos para videos", desc: "Estilo TikTok o clásico, quemados en el video", pro: true },
  { id: "doblar", g: "editar", ico: "🌎", titulo: "Traducir y doblar", desc: "Tu audio o video con voz en otro idioma", pro: true },
  { id: "transcribir", g: "editar", ico: "📝", titulo: "Transcribir audio o video", desc: "Sube el archivo y obtén el texto", pro: true },
  { id: "oficina", g: "docs", ico: "📊", titulo: "Excel, Word o PDF", desc: "Plantillas listas: presupuestos, informes, notas…", pro: true },
  { id: "presentacion", g: "docs", ico: "📽️", titulo: "Presentación PowerPoint", desc: "Diapositivas editables con revisión de diseño", pro: true },
  { id: "hoja_vida", g: "docs", ico: "📋", titulo: "Hoja de vida", desc: "CV profesional en PDF y Word (y carta)", pro: true },
  { id: "estudiar", g: "docs", ico: "📚", titulo: "Estudiar", desc: "Tarjetas tipo Anki que se guardan, quiz o guía", pro: false },
  { id: "correo", g: "docs", ico: "✉️", titulo: "Redactar un correo", desc: "Plantillas: solicitud, seguimiento, ventas…", pro: false },
  { id: "redactar", g: "docs", ico: "✍️", titulo: "Redactar un texto", desc: "Publicaciones, guiones, artículos, ideas", pro: false },
  { id: "redes", g: "descargas", ico: "📲", titulo: "Descargar de redes", desc: "Videos, fotos y carruseles de Instagram, TikTok, Facebook, X…", pro: true, nuevo: true },
  { id: "youtube", g: "descargas", ico: "⬇️", titulo: "Descargar de YouTube", desc: "Música MP3 o video MP4 · cualquier enlace", pro: true },
  { id: "web", g: "mas", ico: "🌐", titulo: "Crear página web", desc: "Con enlace propio y base de datos para formularios", pro: true },
  { id: "recordatorio", g: "mas", ico: "⏰", titulo: "Aviso por Telegram", desc: "Te escribo a la hora que elijas", pro: true },
];

/* Plantillas de archivos de oficina: [formato, id, nombre, pedido, ejemplo] */
const PLANTILLAS_OFICINA = [
  ["excel", "presupuesto", "Presupuesto mensual", "un presupuesto mensual con ingresos y gastos por categoría, fórmulas de totales y saldo, formato de moneda y un gráfico de gastos por categoría", "Ej.: presupuesto familiar con un salario de 2.500.000 COP"],
  ["excel", "inventario", "Inventario de productos", "un inventario con código, producto, cantidad, precio unitario y valor total con fórmulas, y alerta de stock bajo con formato condicional", "Ej.: tienda de útiles escolares, 20 productos"],
  ["excel", "notas", "Planilla de notas", "una planilla de calificaciones con estudiantes, notas por periodo, promedio con fórmulas, colores según desempeño y resumen del grupo", "Ej.: 25 estudiantes, 4 notas por periodo, escala de 1 a 5"],
  ["excel", "cotizacion", "Cotización o cuenta de cobro", "una cotización profesional con datos del cliente, ítems, cantidades, precios, subtotal, IVA y total con fórmulas", "Ej.: 3 talleres de IA para docentes a 400.000 COP cada uno"],
  ["excel", "cronograma", "Cronograma u horario", "un cronograma tipo diagrama de Gantt (o un horario semanal) con fechas, responsables y colores por estado", "Ej.: proyecto de feria de ciencias de 6 semanas"],
  ["excel", "datos", "Analizar o graficar mis datos", "un análisis de los datos: tabla limpia, estadísticas clave y gráficos claros", "Pega tus datos aquí o adjunta el archivo con ＋"],
  ["word", "informe", "Informe", "un informe con portada, introducción, desarrollo con subtítulos, tablas si aplican y conclusiones", "Ej.: informe de resultados de la feria de ciencias 2026"],
  ["word", "carta", "Carta formal", "una carta formal bien estructurada (lugar y fecha, destinatario, asunto, cuerpo y firma)", "Ej.: carta al rector solicitando el auditorio para el 5 de diciembre"],
  ["word", "cv", "Hoja de vida", "una hoja de vida moderna y profesional (perfil, experiencia, estudios, habilidades)", "Ej.: ingeniero electrónico, 8 años de docente, experto en robótica"],
  ["word", "acta", "Acta de reunión", "un acta de reunión con asistentes, orden del día, desarrollo, compromisos y responsables", "Ej.: reunión de padres de familia de grado 9, 3 compromisos"],
  ["word", "plan", "Plan de clase", "un plan de clase con objetivos, competencias, momentos (inicio, desarrollo, cierre), recursos y evaluación", "Ej.: la célula para grado 6, 2 horas"],
  ["pdf", "guia", "Guía o taller para imprimir", "una guía/taller para imprimir con explicación breve, ejemplos y ejercicios con espacio para responder", "Ej.: taller de fracciones para grado 5, 10 ejercicios"],
  ["pdf", "certificado", "Certificado o diploma", "un certificado/diploma elegante en horizontal listo para imprimir", "Ej.: certificado de asistencia a la clase de IA, 26 de noviembre de 2026"],
  ["pdf", "folleto", "Folleto o volante informativo", "un folleto/volante atractivo con título, beneficios, información clave y llamado a la acción", "Ej.: curso de robótica para niños, sábados 9 a. m."],
  ["otro", "otro", "Otro (lo describo yo)", "", "Describe el archivo que necesitas"],
];
const NOMBRE_FORMATO = { excel: "un archivo Excel (.xlsx)", word: "un documento Word (.docx)", pdf: "un PDF" };

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
let grupoAtajos = (() => { try { return localStorage.getItem("simb_grupo") || "todas"; } catch { return "todas"; } })();
function tarjetaAtajo(a) {
  const bloqueado = a.pro && !esPro();
  return el("button", { type: "button", class: "atajo g-" + a.g + (bloqueado ? " bloqueado" : ""), "data-id": a.id,
    onclick: () => bloqueado ? abrirPro(`«${a.titulo}» es parte de la versión Pro.`) : abrirAtajo(a.id) },
    el("span", { class: "at-ico", "aria-hidden": "true" }, a.ico),
    el("span", { class: "at-txt" }, el("b", {}, a.titulo), el("small", {}, a.desc)),
    bloqueado ? el("span", { class: "at-marca pro" }, "PRO") : a.nuevo ? el("span", { class: "at-marca nuevo" }, "NUEVO") : null);
}
function pintarAtajos() {
  const c = $("atajos"); c.textContent = "";
  if (!GRUPOS.some(([g]) => g === grupoAtajos)) grupoAtajos = "todas";
  const elegir = (g) => { grupoAtajos = g; try { localStorage.setItem("simb_grupo", g); } catch { /* sin almacenamiento */ } pintarAtajos(); };
  c.append(el("div", { class: "at-filtros", role: "tablist", "aria-label": "Tipos de herramientas" },
    [["todas", "✨", "Todas"], ...GRUPOS].map(([g, ico, nom]) => el("button", { type: "button", role: "tab",
      "aria-selected": String(grupoAtajos === g), onclick: () => elegir(g) }, el("span", { "aria-hidden": "true" }, ico), nom))));
  for (const [g, , nom] of GRUPOS) {
    if (grupoAtajos !== "todas" && grupoAtajos !== g) continue;
    c.append(el("section", { class: "at-grupo", "aria-label": nom },
      grupoAtajos === "todas" ? el("h4", { class: "at-tit" }, nom) : null,
      el("div", { class: "at-grid" }, ATAJOS.filter((a) => a.g === g).map(tarjetaAtajo))));
  }
}

function campoOpciones(nombre, opciones, valor) {
  return el("div", { class: "opciones" }, opciones.map(([v, t]) =>
    el("label", {}, el("input", { type: "radio", name: nombre, value: v, checked: v === valor }), t)));
}
/* Campo de archivo para los atajos: usa el adjunto que ya tengas del tipo pedido, o el que elijas aquí */
function campoArchivo(accept, etiqueta, prefijo) {
  const tipos = prefijo.split("|");
  const ya = [...adjuntos].reverse().find((a) => !a.subiendo && tipos.some((t) => (a.mime || "").startsWith(t)));
  const input = el("input", { type: "file", accept, required: ya ? null : true });
  const campo = el("label", {}, etiqueta + (ya ? ` · usaré «${ya.nombre}» (o elige otro)` : ""), input);
  const obtener = async () => {
    const f = input.files?.[0];
    if (!f) return !!ya;
    const subidos = await subirArchivos([f]);
    return subidos.length > 0;
  };
  return { campo, obtener };
}
function campoIdioma(nombre, auto, etiqueta = "Idioma del audio") {
  return el("label", {}, etiqueta, el("select", { name: nombre }, [...(auto ? [["auto", "Detectar automáticamente"]] : []), ["es-US", "Español"], ["en-US", "Inglés"],
    ["pt-BR", "Portugués"], ["fr-FR", "Francés"], ["it-IT", "Italiano"], ["de-DE", "Alemán"]].map(([v, t]) => el("option", { value: v }, t))));
}
function abrirDialogo(titulo, campos, nota, okTexto, alAceptar) {
  const dlg = $("dlg");
  $("dlg-titulo").textContent = titulo; $("dlg-nota").textContent = nota || "";
  $("dlg-ok").textContent = okTexto || "Crear";
  const c = $("dlg-campos"); c.textContent = ""; c.append(...campos);
  dlg.onclose = () => {
    if (dlg.returnValue !== "ok") return;
    const f = new FormData($("dlg-form"));
    if (f.get("nivel_ia")) { nivel = f.get("nivel_ia"); pintarNiveles(); }
    alAceptar(f);
  };
  dlg.returnValue = ""; dlg.showModal();
}
const quedan = (k, l) => Math.max(0, (estado?.limites?.[l] || 0) - (estado?.usado?.[k] || 0));

async function abrirAtajo(id, conAdjunta = false) {
  if (id === "imagen") {
    abrirDialogo(conAdjunta ? "Editar imagen" : "Crear imagen", [
      el("label", {}, "¿Qué quieres ver?", el("textarea", { name: "texto", required: true, placeholder: conAdjunta ? "Ej.: cambia el fondo por un páramo al amanecer" : "Ej.: un colibrí dorado sobre un frailejón al amanecer, foto realista" })),
      campoOpciones("formato", [["1:1", "Cuadrada"], ["4:5", "Instagram 4:5"], ["9:16", "Historia 9:16"], ["16:9", "Horizontal"]], "1:1"),
    ], `Te quedan ${quedan("imagenes", "imagenes")} imágenes esta semana. Se guarda en ☁️ Mi nube › Imágenes.`, "Crear imagen",
      (f) => f.get("texto")?.trim() && enviar({ accion: "imagen", params: { texto: f.get("texto").trim(), formato: f.get("formato") } }));
  } else if (id === "video") {
    abrirDialogo("Video con IA", [
      el("label", {}, "Describe la escena", el("textarea", { name: "texto", required: true, placeholder: "Ej.: una bandada de estorninos al atardecer, cámara lenta" })),
      campoOpciones("formato", [["9:16", "Vertical 9:16"], ["16:9", "Horizontal 16:9"]], "9:16"),
      el("div", { class: "campo-titulo" }, "Duración"),
      campoOpciones("segundos", [3, 4, 5, 6, 7, 8].map((n) => [String(n), `${n} s`]), "4"),
    ], `Te quedan ${quedan("videos", "videos")} videos esta semana. Tarda alrededor de un minuto.`, "Crear video",
      (f) => f.get("texto")?.trim() && enviar({ accion: "video", params: { texto: f.get("texto").trim(), formato: f.get("formato"), segundos: Math.min(8, Math.max(3, +f.get("segundos") || 4)) } }));
  } else if (id === "voz") {
    const sel = el("select", { name: "voz" }, ["Femenina", "Masculina"].map((g) =>
      el("optgroup", { label: "Voces " + g.toLowerCase() + "s" }, VOCES.filter((v) => v.genero === g)
        .map((v) => el("option", { value: v.id, selected: v.id === "Puck" ? true : null }, `${g} · ${v.tipo}`)))));
    abrirDialogo("Texto a voz", [
      el("label", {}, "Texto", el("textarea", { name: "texto", required: true, placeholder: "Escribe o pega el texto que quieres escuchar" })),
      campoOpciones("motor", [["chirp", "Voz natural"], ["gemini", "Voz expresiva (para videos)"]], "chirp"),
      el("label", {}, "Voz", sel),
      el("label", {}, "Estilo (solo voz expresiva)", el("input", { type: "text", name: "estilo", placeholder: "Ej.: con entusiasmo y ritmo rápido" })),
    ], `Te quedan ${(quedan("tts_chirp_seg", "tts_chirp_seg") / 60).toFixed(0)} min de voz natural y ${(quedan("tts_gemini_seg", "tts_gemini_seg") / 60).toFixed(0)} min de voz expresiva.`, "Generar audio",
      (f) => f.get("texto")?.trim() && enviar({ accion: f.get("motor") === "gemini" ? "voz_gemini" : "voz_chirp", params: { texto: f.get("texto").trim(), voz: f.get("voz"), estilo: f.get("estilo") || "" } }));
  } else if (id === "youtube") {
    const area = el("textarea", { name: "urls", required: true, placeholder: "Pega uno o varios enlaces (de la app, del navegador, Shorts, Music…)\nhttps://youtu.be/…\nhttps://www.youtube.com/watch?v=…" });
    const vista = el("small", { class: "nota" });
    area.oninput = () => { const n = enlacesYT(area.value).length; vista.textContent = n ? `✓ ${n} enlace${n > 1 ? "s" : ""} válido${n > 1 ? "s" : ""}` : ""; };
    abrirDialogo("Descargar de YouTube", [
      el("label", {}, "Enlaces (hasta 10)", area), vista,
      campoOpciones("formato", [["mp3", "🎵 Solo audio MP3 (va a «Música»)"], ["mp4", "🎬 Video MP4"]], "mp3"),
      el("div", { class: "campo-titulo" }, "Calidad"),
      campoOpciones("calidad", [["baja", "Baja (más rápida y liviana)"], ["media", "Media"], ["alta", "Alta"]], "baja"),
    ], `Funciona con cualquier enlace de YouTube: se limpia solo (quita ?si=, listas, tiempos…). Máximo 48 MB por archivo. Cada enlace cuenta 1 descarga: te quedan ${quedan("descargas", "descargas")} esta semana. Descarga solo contenido que tengas derecho a usar.`, "Descargar",
      (f) => {
        const urls = enlacesYT(f.get("urls") || "").slice(0, 10);
        if (!urls.length) return alert("No encontré enlaces de YouTube. Para Instagram, TikTok o Facebook usa «📲 Descargar de redes».");
        enviar({ accion: "youtube_" + f.get("formato"), params: { url: urls.join("\n"), urls, calidad: f.get("calidad") } });
      });
  } else if (id === "redes") {
    const area = el("textarea", { name: "urls", required: true, placeholder: "Pega uno o varios enlaces: en la app toca «Compartir» → «Copiar enlace».\nhttps://www.instagram.com/p/…   https://www.instagram.com/reel/…\nhttps://www.tiktok.com/@usuario/video/…   https://vm.tiktok.com/…\nhttps://www.facebook.com/…   https://x.com/usuario/status/…" });
    const chips = el("div", { class: "red-chips", "aria-live": "polite" });
    const marcar = () => {
      const urls = enlacesRedes(area.value), yt = enlacesYT(area.value);
      chips.textContent = "";
      for (const u of urls.slice(0, 10)) {
        const red = redDe(u);
        chips.append(el("span", { class: "red-chip ok" }, el("b", {}, red.ico), red.nombre));
      }
      if (yt.length) chips.append(el("span", { class: "red-chip aviso" }, `${yt.length} de YouTube: usa «⬇️ Descargar de YouTube»`));
      if (urls.length > 10) chips.append(el("span", { class: "red-chip aviso" }, "Máximo 10 enlaces"));
    };
    area.oninput = marcar;
    abrirDialogo("Descargar de redes", [
      el("div", { class: "redes-logos", "aria-label": "Redes compatibles" }, REDES_UI.slice(0, 8).map((r) => el("span", { title: r.nombre }, r.ico, " ", r.nombre))),
      el("label", {}, "Enlaces (hasta 10)", area), chips,
      el("div", { class: "campo-titulo" }, "¿Qué quieres?"),
      campoOpciones("formato", [["mp4", "🎬 Video y fotos tal cual (carruseles completos)"], ["mp3", "🎵 Solo el audio MP3"]], "mp4"),
      el("div", { class: "campo-titulo" }, "Calidad del video"),
      campoOpciones("calidad", [["baja", "Baja (liviana)"], ["media", "Media"], ["alta", "Alta (hasta 1080p)"]], "media"),
    ], `Solo publicaciones públicas · hasta 10 archivos por publicación · máximo 48 MB por archivo. Cada enlace cuenta 1 descarga: te quedan ${quedan("descargas", "descargas")} esta semana. Descarga solo contenido que tengas derecho a usar.`, "Descargar",
      (f) => {
        const urls = enlacesRedes(f.get("urls") || "").slice(0, 10);
        if (!urls.length) return alert("No encontré enlaces de Instagram, TikTok, Facebook, X, Pinterest u otras redes compatibles.");
        enviar({ accion: "redes_" + f.get("formato"), params: { url: urls.join("\n"), urls, calidad: f.get("calidad") } });
      });
  } else if (id === "foto" || id === "producto") {
    const { campo, obtener } = campoArchivo("image/*", "Foto", "image/");
    const esProd = id === "producto";
    const detalle = el("input", { type: "text", name: "detalle", maxlength: 300 });
    const fondo = el("div", {}, el("div", { class: "campo-titulo" }, "Fondo"),
      campoOpciones("fondo", [["transparente", "Transparente (PNG)"], ["blanco", "Blanco"]], "transparente"));
    const modos = [["quitar_fondo", "✂️ Quitar fondo"], ["mejorar", "✨ Mejorar calidad"], ["restaurar", "🩹 Restaurar foto antigua"],
      ["colorear", "🎨 Colorear blanco y negro"], ["cambiar_fondo", "🏞️ Cambiar fondo"], ["retrato", "👔 Retrato profesional (CV)"]];
    const ayudas = { quitar_fondo: "Opcional: algo a tener en cuenta", mejorar: "Opcional: ej. más luz, colores más cálidos",
      restaurar: "Opcional: ej. quitar la mancha de la esquina", colorear: "Opcional: ej. vestido azul, carro rojo",
      cambiar_fondo: "Obligatorio: ej. playa del Caribe al atardecer", retrato: "Opcional: ej. camisa blanca, sin corbata" };
    const pintarModo = (m) => { fondo.hidden = m !== "quitar_fondo"; detalle.placeholder = ayudas[m]; detalle.required = m === "cambiar_fondo"; };
    const escenas = [["estudio", "⬜ Estudio blanco"], ["marmol", "🤍 Mármol"], ["madera", "🪵 Madera rústica"], ["naturaleza", "🌿 Naturaleza"],
      ["lujo", "🖤 Lujo oscuro"], ["colores", "🎨 Fondo de color"], ["uso", "🙋 En uso (lifestyle)"], ["flatlay", "📐 Vista desde arriba"]];
    const campos = esProd ? [
      campo,
      el("div", { class: "campo-titulo" }, "Escena"), campoOpciones("escena", escenas, "estudio"),
      el("div", { class: "campo-titulo" }, "Formato"), campoOpciones("formato", [["1:1", "Cuadrada"], ["4:5", "Instagram 4:5"], ["9:16", "Historia 9:16"], ["16:9", "Horizontal"]], "1:1"),
      el("div", { class: "campo-titulo" }, "¿Cuántas versiones?"), campoOpciones("variantes", [["1", "1"], ["2", "2"], ["3", "3"]], "1"),
      el("label", {}, "Detalles (opcional)", Object.assign(detalle, { placeholder: "Ej.: con granos de café alrededor, ambiente navideño" })),
    ] : [campo, el("div", { class: "campo-titulo" }, "¿Qué hago?"), campoOpciones("modo", modos, "quitar_fondo"), fondo,
      el("label", {}, "Detalles", detalle)];
    abrirDialogo(esProd ? "Foto de producto pro" : "Mejorar foto", campos,
      `Cada foto cuenta como 1 imagen de tu cupo (usa Nano Banana). Te quedan ${quedan("imagenes", "imagenes")} esta semana.`
        + (esProd ? " Tip: una foto nítida y con buena luz da mejores resultados." : ""), esProd ? "Crear fotos" : "Aplicar",
      async (f) => {
        const n = esProd ? +f.get("variantes") || 1 : 1;
        if (n > quedan("imagenes", "imagenes")) return alert(`Te quedan ${quedan("imagenes", "imagenes")} imágenes esta semana.`);
        if (!(await obtener())) return;
        enviar(esProd
          ? { accion: "producto", params: { escena: f.get("escena"), formato: f.get("formato"), variantes: n, detalle: f.get("detalle") || "" } }
          : { accion: "foto", params: { modo: f.get("modo"), fondo: f.get("fondo") || "transparente", detalle: f.get("detalle") || "" } });
      });
    if (!esProd) { pintarModo("quitar_fondo"); $("dlg-campos").querySelectorAll('input[name="modo"]').forEach((r) => r.addEventListener("change", () => pintarModo(r.value))); }
  } else if (id === "musica") {
    const generos = ["Cumbia", "Salsa", "Vallenato", "Reguetón", "Pop", "Rock", "Lo-fi", "Electrónica", "Hip hop", "Jazz", "Acústica",
      "Orquestal / cine", "Ambiental / relajante", "Infantil", "Corporativa"];
    abrirDialogo("Crear música", [
      el("label", {}, "¿Para qué es o cómo la imaginas?", el("textarea", { name: "descripcion", required: true, maxlength: 600, placeholder: "Ej.: fondo alegre para un video de mi panadería, con guitarra y percusión suave" })),
      el("div", { class: "fila-2" },
        el("label", {}, "Género", el("select", { name: "estilo" }, el("option", { value: "" }, "Que lo elija Simbi"), generos.map((g) => el("option", { value: g }, g)))),
        el("label", {}, "Instrumentos (opcional)", el("input", { type: "text", name: "instrumentos", placeholder: "Ej.: piano y violín" }))),
      el("div", { class: "campo-titulo" }, "Ánimo"),
      campoOpciones("animo", [["alegre", "😄 Alegre"], ["tranquilo", "😌 Tranquilo"], ["motivador", "💪 Motivador"], ["épico", "🔥 Épico"],
        ["romántico", "❤️ Romántico"], ["nostálgico", "🌧️ Nostálgico"], ["misterioso", "🕵️ Misterioso"]], "alegre"),
      el("div", { class: "campo-titulo" }, "Ritmo"), campoOpciones("tempo", [["lento", "Lento"], ["medio", "Medio"], ["rápido", "Rápido"]], "medio"),
      el("div", { class: "campo-titulo" }, "Versiones"), campoOpciones("variantes", [["1", "1"], ["2", "2 (para elegir)"]], "1"),
    ], `Música instrumental original de ~30 s (sin voz), libre para tus videos. Cada versión cuenta 1 canción: te quedan ${quedan("musica", "musica")} esta semana. Queda en 🎧 Mi música.`, "Crear música",
      (f) => {
        const n = +f.get("variantes") || 1;
        if (n > quedan("musica", "musica")) return alert(`Te quedan ${quedan("musica", "musica")} canciones esta semana.`);
        enviar({ accion: "musica", params: { descripcion: f.get("descripcion").trim(), estilo: f.get("estilo"), animo: f.get("animo"),
          tempo: f.get("tempo"), instrumentos: f.get("instrumentos") || "", variantes: n } });
      });
  } else if (id === "subtitulos") {
    const { campo, obtener } = campoArchivo("video/*", "Video (máx. 3 min)", "video/");
    abrirDialogo("Subtítulos para videos", [
      campo,
      el("div", { class: "campo-titulo" }, "Estilo"),
      campoOpciones("estilo", [["tiktok", "🔥 TikTok (palabras grandes)"], ["clasico", "🎬 Clásico (con caja)"], ["simple", "✏️ Simple"]], "tiktok"),
      el("div", { class: "campo-titulo" }, "Posición"), campoOpciones("posicion", [["abajo", "Abajo"], ["centro", "Centro"], ["arriba", "Arriba"]], "abajo"),
      el("div", { class: "fila-2" }, campoIdioma("idioma", true),
        el("label", { class: "opcion-sola" }, el("input", { type: "checkbox", name: "mayusculas", checked: true }), "EN MAYÚSCULAS")),
    ], `Usa minutos de transcripción: te quedan ${(quedan("stt_seg", "stt_seg") / 60).toFixed(0)} min esta semana. Recibes el video y el archivo .srt.`, "Subtitular",
      async (f) => {
        if (!(await obtener())) return;
        enviar({ accion: "subtitulos", params: { estilo: f.get("estilo"), posicion: f.get("posicion"), idioma: f.get("idioma"), mayusculas: !!f.get("mayusculas") } });
      });
  } else if (id === "doblar") {
    const { campo, obtener } = campoArchivo("audio/*,video/*", "Audio o video (máx. 5 min)", "audio/|video/");
    const sel = el("select", { name: "voz" }, ["Femenina", "Masculina"].map((g) =>
      el("optgroup", { label: "Voces " + g.toLowerCase() + "s" }, VOCES.filter((v) => v.genero === g)
        .map((v) => el("option", { value: v.id, selected: v.id === "Puck" ? true : null }, `${g} · ${v.tipo}`)))));
    abrirDialogo("Traducir y doblar", [
      campo,
      el("div", { class: "fila-2" },
        el("label", {}, "Traducir al", el("select", { name: "destino" }, [["en-US", "🇺🇸 Inglés"], ["es-US", "🇨🇴 Español"], ["pt-BR", "🇧🇷 Portugués"],
          ["fr-FR", "🇫🇷 Francés"], ["it-IT", "🇮🇹 Italiano"], ["de-DE", "🇩🇪 Alemán"]].map(([v, t]) => el("option", { value: v }, t)))),
        el("label", {}, "Voz del doblaje", sel)),
      el("div", { class: "fila-2" }, campoIdioma("origen", true, "Idioma original"),
        el("label", { class: "opcion-sola" }, el("input", { type: "checkbox", name: "fondo", checked: true }), "Dejar el sonido original bajito")),
    ], `Usa minutos de transcripción y de voz natural (te quedan ${(quedan("stt_seg", "stt_seg") / 60).toFixed(0)} y ${(quedan("tts_chirp_seg", "tts_chirp_seg") / 60).toFixed(0)} min). Recibes el archivo doblado y la traducción en texto.`, "Doblar",
      async (f) => {
        if (!(await obtener())) return;
        enviar({ accion: "doblar", params: { idioma_destino: f.get("destino"), voz: f.get("voz"), idioma_origen: f.get("origen"), conservar_fondo: !!f.get("fondo") } });
      });
  } else if (id === "hoja_vida") {
    const foto = el("input", { type: "file", accept: "image/*" });
    const anterior = el("input", { type: "file", accept: ".pdf,.doc,.docx,.txt" });
    const t = (name, ph, req) => el("textarea", { name, placeholder: ph, required: req ? true : null, rows: 3, maxlength: 3000 });
    abrirDialogo("Hoja de vida", [
      el("div", { class: "fila-2" },
        el("label", {}, "Nombre completo", el("input", { type: "text", name: "nombre", required: true, maxlength: 100 })),
        el("label", {}, "Cargo al que aspiras", el("input", { type: "text", name: "cargo", maxlength: 120, placeholder: "Ej.: Auxiliar contable" }))),
      el("label", {}, "Contacto", el("input", { type: "text", name: "contacto", maxlength: 300, placeholder: "Celular · correo · ciudad · LinkedIn (opcional)" })),
      el("label", {}, "Sobre ti (perfil)", t("perfil", "2-3 frases: quién eres, en qué eres bueno y qué buscas")),
      el("label", {}, "Experiencia", t("experiencia", "Empresa · cargo · fechas · qué lograste. Ej.: Tienda XYZ, cajera, 2022-2024, manejé caja de 3M diarios sin descuadres", true)),
      el("label", {}, "Estudios", t("educacion", "Ej.: Técnico en contabilidad, SENA, 2021")),
      el("div", { class: "fila-2" },
        el("label", {}, "Habilidades", t("habilidades", "Excel, atención al cliente, trabajo en equipo…")),
        el("label", {}, "Idiomas, cursos y otros", t("otros", "Inglés básico, curso de IA, licencia de conducción…"))),
      el("div", { class: "campo-titulo" }, "Estilo"),
      campoOpciones("estilo", [["moderno", "🟦 Moderno"], ["clasico", "📄 Clásico"], ["creativo", "🎨 Creativo"], ["ats", "🤖 Para plataformas (ATS)"]], "moderno"),
      el("div", { class: "fila-2" },
        el("label", {}, "Foto (opcional)", foto),
        el("label", {}, "Hoja de vida anterior (opcional)", anterior)),
      el("div", { class: "fila-2" },
        el("label", {}, "Color (opcional)", el("input", { type: "text", name: "color", placeholder: "Ej.: azul oscuro, vinotinto" })),
        el("label", { class: "opcion-sola" }, el("input", { type: "checkbox", name: "carta" }), "También carta de presentación")),
      campoNivel("medio"),
    ], "Recibes la hoja de vida en PDF y en Word editable. Simbi no inventa datos: lo que no pongas no aparece. Tip: con 🖼️ Mejorar foto › Retrato profesional puedes preparar tu foto antes.", "Crear hoja de vida",
      async (f) => {
        const archivos = [foto.files?.[0], anterior.files?.[0]].filter(Boolean);
        if (archivos.length && (await subirArchivos(archivos)).length < archivos.length) return;
        const params = {};
        for (const k of ["nombre", "cargo", "contacto", "perfil", "experiencia", "educacion", "habilidades", "otros", "estilo", "color"]) params[k] = (f.get(k) || "").trim();
        params.carta = f.get("carta") ? "1" : "";
        enviar({ accion: "hoja_vida", params });
      });
  } else if (id === "transcribir") {
    const input = el("input", { type: "file", name: "archivo", accept: "audio/*,video/*", required: true });
    abrirDialogo("Transcribir audio o video", [
      el("label", {}, "Archivo de audio o video (máx. 50 MB)", input),
      el("label", {}, "Idioma", el("select", { name: "idioma" }, [["auto", "Detectar automáticamente"], ["es-US", "Español"], ["en-US", "Inglés"],
        ["pt-BR", "Portugués"], ["fr-FR", "Francés"], ["it-IT", "Italiano"], ["de-DE", "Alemán"]].map(([v, t]) => el("option", { value: v }, t)))),
    ], `Te quedan ${(quedan("stt_seg", "stt_seg") / 60).toFixed(0)} min de transcripción esta semana. Luego puedes pedirle a Simbi un resumen, subtítulos o un acta.`, "Transcribir",
      async (f) => {
        const archivo = input.files?.[0]; if (!archivo) return;
        const [a] = await subirArchivos([archivo]);
        if (a) enviar({ accion: "transcribir", params: { archivo: a.nombre, idioma: f.get("idioma") || "auto" } });
      });
  } else if (id === "web") {
    // 🔌 Tokens propios (opcionales): si están, se publica en su GitHub y la base va a su Supabase
    const zonaCx = el("div", {}, el("small", { class: "nota" }, "Cargando…"));
    const pintarCx = async () => {
      const cx = await apiNube("/conexiones").catch(() => null);
      zonaCx.textContent = "";
      if (!cx) { zonaCx.append(el("small", { class: "nota" }, "No se pudieron cargar las conexiones.")); return; }
      det.querySelector("summary .estado").textContent = (cx.github.conectado ? "GitHub ✅" : "GitHub —") + " · " + (cx.supabase.ref ? "Supabase ✅" : "Supabase —");
      zonaCx.append(cajaConexiones(cx, pintarCx));
    };
    const det = el("details", { class: "con-det" }, el("summary", {}, "🔌 Tu GitHub y tu Supabase ", el("small", {}, "(opcional) "), el("span", { class: "estado" }, "")), zonaCx);
    pintarCx();
    const tipos = [["negocio", "Negocio o emprendimiento"], ["evento", "Evento, clase o invitación"], ["portafolio", "Portafolio / hoja de vida"],
      ["catalogo", "Catálogo de productos con pedidos"], ["formulario", "Formulario, encuesta o inscripción"], ["educativa", "Página educativa o de un curso"],
      ["enlaces", "Página de enlaces (link in bio)"], ["otro", "Otra (la describo yo)"]];
    const funciones = [["contacto", "📩 Formulario de contacto"], ["registro", "📝 Inscripción o registro"], ["reservas", "📅 Reservas o citas"],
      ["pedidos", "🛒 Pedidos"], ["comentarios", "💬 Comentarios públicos"], ["encuesta", "📊 Encuesta"]];
    abrirDialogo("Crear página web", [
      el("label", {}, "Tipo de página", el("select", { name: "tipo" }, tipos.map(([v, t]) => el("option", { value: v }, t)))),
      el("label", {}, "Nombre", el("input", { type: "text", name: "nombre", required: true, maxlength: 80, placeholder: "Ej.: Panadería La Espiga" })),
      el("label", {}, "Describe qué debe tener", el("textarea", { name: "desc", required: true, placeholder: "Ej.: panadería artesanal en Pasto, horarios, productos con precios, ubicación, botón de WhatsApp 300 123 4567" })),
      el("div", { class: "campo-titulo" }, "Guardar información (base de datos)"),
      el("div", { class: "opciones" }, funciones.map(([v, t]) => el("label", {}, el("input", { type: "checkbox", name: "fn", value: v }), t))),
      el("label", { class: "opcion-sola" }, el("input", { type: "checkbox", name: "login" }), "🔐 Con inicio de sesión (cada persona ve solo sus datos: mi cuenta, mis pedidos…)"),
      el("div", { class: "fila-2" }, el("label", {}, "Colores (opcional)", el("input", { type: "text", name: "colores", placeholder: "Ej.: café y crema, o #6D28D9" })), campoNivel("dificil")),
      esPro() ? det : null,
    ], "Simbi la diseña y la publica sola, siempre con copia en Google Cloud. Si pones tu token de GitHub queda además en tuusuario.github.io/…; con tu token de Supabase los formularios guardan en TU base de datos. Tus webs aparecen en «🌐 Webs». Para cambiarla, pídeselo en la misma conversación. Recomendado: nivel Difícil.", "Crear y publicar",
      async (f) => {
        // Tokens pegados pero sin tocar «Guardar»: se conectan solos antes de crear la web
        for (const inp of det.querySelectorAll("input[data-servicio]")) {
          const token = inp.value.trim();
          if (!token) continue;
          try {
            const r = await apiNube("/conexiones/" + inp.dataset.servicio, { method: "POST", body: JSON.stringify({ token }) });
            if (inp.dataset.servicio === "supabase" && !r.ref && (r.proyectos || []).length > 1)
              alert("Supabase quedó conectado. Tienes varios proyectos: elige cuál usar en «🌐 Crear página web › 🔌 Tu GitHub y tu Supabase».");
          } catch (e) {
            if (!confirm(`No se pudo conectar ${inp.dataset.servicio === "github" ? "GitHub" : "Supabase"}: ${e.message}\n\n¿Crear la web de todos modos?`)) return;
          }
        }
        const t = tipos.find((x) => x[0] === f.get("tipo"));
        const fns = f.getAll("fn").map((v) => funciones.find((x) => x[0] === v)[1].replace(/^\S+\s/, "").toLowerCase());
        enviar({ mensaje: `Crea y publica una página web (${t[1].toLowerCase()}) llamada «${f.get("nombre").trim()}».\n${f.get("desc").trim()}\n` +
          (fns.length ? `Debe guardar información con base de datos: ${fns.join(", ")}.\n` : "") +
          (f.get("login") ? "Debe tener inicio de sesión con correo: cada persona ve y gestiona solo sus propios datos (colecciones privadas).\n" : "") +
          (f.get("colores")?.trim() ? `Colores: ${f.get("colores").trim()}.\n` : "") +
          "Diseño moderno, atractivo y adaptado a celular." + (adjuntos.length ? " Usa las imágenes que adjunto." : "") });
      });
  } else if (id === "recordatorio") {
    abrirRecordatorios();
  } else if (id === "oficina") {
    const area = el("textarea", { name: "detalles", required: true });
    const selFmt = el("select", { name: "formato" }, [["excel", "📊 Excel"], ["word", "📄 Word"], ["pdf", "📕 PDF"]].map(([v, t]) => el("option", { value: v }, t)));
    const sel = el("select", { name: "plantilla" }, [["excel", "📊 Excel"], ["word", "📄 Word"], ["pdf", "📕 PDF"], ["otro", "✏️ Otro"]].map(([g, t]) =>
      el("optgroup", { label: t }, PLANTILLAS_OFICINA.filter((p) => p[0] === g).map((p) => el("option", { value: p[1] }, p[2])))));
    const alCambiar = () => { const p = PLANTILLAS_OFICINA.find((x) => x[1] === sel.value); area.placeholder = p[4]; if (p[0] !== "otro") selFmt.value = p[0]; };
    sel.onchange = alCambiar; alCambiar();
    abrirDialogo("Excel, Word o PDF", [
      el("label", {}, "¿Qué necesitas? (plantilla)", sel),
      el("label", {}, "Detalles", area),
      el("div", { class: "fila-2" }, el("label", {}, "Formato", selFmt), campoNivel()),
    ], "Si tienes un archivo de base (datos, borrador, logo), adjúntalo con ＋ antes. Un revisor de diseño mira el PDF/Word antes de entregarlo. Queda en ☁️ Mi nube › Documentos.", "Crear archivo",
      (f) => {
        const p = PLANTILLAS_OFICINA.find((x) => x[1] === f.get("plantilla"));
        const fmt = NOMBRE_FORMATO[f.get("formato")] || "el archivo";
        enviar({ mensaje: `Crea ${fmt}${p[3] ? " con " + p[3] : ""}.\nDetalles: ${f.get("detalles").trim()}\n` +
          "Diseño profesional y claro, listo para usar." + (adjuntos.length ? " Usa el archivo que adjunto como base." : "") });
      });
  } else if (id === "presentacion") {
    const paletas = [["azul", "Azul corporativo (#1E3A8A, #3B82F6, blanco)"], ["verde", "Verde natural (#14532D, #22C55E, crema)"],
      ["oscuro", "Oscuro moderno (#0F172A, #38BDF8, #F472B6)"], ["calido", "Cálido (#7C2D12, #F97316, #FDE68A)"],
      ["sobrio", "Blanco y negro elegante (#111111, #F5F5F5, acento #D4AF37)"], ["simbi", "Colores de Simbi (#0B1117, #2EE6D6, #FF5A3C)"]];
    abrirDialogo("Presentación PowerPoint", [
      el("label", {}, "Tema", el("textarea", { name: "tema", required: true, placeholder: "Ej.: La ley de Ohm para grado 9, con ejemplos de la vida diaria y ejercicios" })),
      el("div", { class: "fila-2" }, el("label", {}, "Número de diapositivas", el("input", { type: "number", name: "n", min: 1, max: 25, value: 2 })), campoNivel()),
      el("label", {}, "Colores", el("select", { name: "paleta" }, paletas.map(([v, t]) => el("option", { value: v }, t)), el("option", { value: "propia" }, "Otros (los escribo abajo)"))),
      el("label", {}, "Colores propios (opcional)", el("input", { type: "text", name: "colores", placeholder: "Ej.: morado y amarillo, o #6D28D9 y #FACC15" })),
      campoOpciones("estilo", [["minimalista", "Minimalista"], ["corporativo", "Corporativo"], ["creativo", "Creativo"], ["educativo", "Educativo"]], "educativo"),
      el("label", { class: "check" }, el("input", { type: "checkbox", name: "notas", checked: true }), " Incluir notas del orador"),
    ], "Simbi crea un .pptx editable y un revisor de diseño mira las diapositivas antes de entregarlo. Si adjuntas un documento (＋) antes, lo usa como fuente.", "Crear presentación",
      (f) => {
        const pal = paletas.find((x) => x[0] === f.get("paleta"));
        const colores = f.get("colores")?.trim() || (pal ? pal[1] : "a tu criterio, sobria");
        const n = Math.min(25, Math.max(1, +f.get("n") || 2));
        enviar({ mensaje: `Crea una presentación de PowerPoint (.pptx editable) de ${n} diapositiva${n > 1 ? "s" : ""} sobre: ${f.get("tema").trim()}\n` +
          `Estilo: ${f.get("estilo")}. Colores: ${colores}.\n` +
          (n >= 4 ? "Incluye portada, agenda, desarrollo con una idea por diapositiva y elementos visuales, y cierre." : "Aprovecha cada diapositiva con una idea clara y elementos visuales.") +
          (f.get("notas") ? " Agrega notas del orador en cada diapositiva." : "") +
          (adjuntos.length ? " Usa como fuente el documento que adjunto." : "") });
      });
  } else if (id === "estudiar") {
    const pro = esPro();
    abrirDialogo("Estudiar", [
      el("label", {}, "Tema o texto (o adjunta tus apuntes/PDF con ＋ antes)", el("textarea", { name: "tema", required: !adjuntos.length,
        placeholder: "Ej.: farmacología de antibióticos betalactámicos · o pega aquí tus apuntes" })),
      el("div", { class: "campo-titulo" }, "¿Qué quieres?"),
      campoOpciones("tipo", [["tarjetas", "🃏 Tarjetas para repasar (tipo Anki)"], ["quiz", "📝 Quiz de opción múltiple"], ["guia", "📖 Guía de estudio"], ["todo", "✨ Todo"]], "tarjetas"),
      el("div", { class: "fila-2" }, el("label", {}, "Cantidad", el("input", { type: "number", name: "n", min: 3, max: 60, value: 15 })), campoNivel()),
      el("div", { class: "campo-titulo" }, "Nivel académico"),
      campoOpciones("nivel", [["primaria", "Primaria"], ["secundaria", "Secundaria"], ["universidad", "Universidad"], ["profesional", "Profesional / especialización"]], "universidad"),
      el("div", { class: "campo-titulo" }, "Entrega"),
      campoOpciones("salida", [["nube", "🃏 Guardar para repasar (☁️ Mi nube › Estudio)" + (pro ? "" : " · Pro")], ["chat", "En el chat"], ["pdf", "PDF para imprimir" + (pro ? "" : " · Pro")], ["excel", "Excel (Anki/Quizlet)" + (pro ? "" : " · Pro")]], pro ? "nube" : "chat"),
    ], "Las tarjetas guardadas se repasan con «Repasar»: primero salen las que más te cuestan y tu progreso queda en este dispositivo.", "Crear",
      (f) => {
        const tema = f.get("tema")?.trim();
        if (!tema && !adjuntos.length) return;
        const salida = f.get("salida");
        if (salida !== "chat" && !esPro()) return abrirPro("Guardar tarjetas, PDF y Excel son de la versión Pro.");
        const n = Math.min(60, Math.max(3, +f.get("n") || 15));
        const tipo = f.get("tipo");
        const fuente = (tema ? `Tema / contenido: ${tema}\n` : "Usa como contenido el material que adjunto.\n") + "Basa todo en información correcta y actual; si adjunto material, cíñete a él.";
        if (salida === "nube" && (tipo === "tarjetas" || tipo === "todo")) {
          enviar({ mensaje: `Crea ${n} tarjetas de estudio tipo Anki (frente: pregunta o concepto concreto; reverso: respuesta precisa y breve, ` +
            `con un dato clave o mnemotecnia si ayuda) para nivel ${f.get("nivel")} y guárdalas con guardar_tarjetas.\n${fuente}` +
            (tipo === "todo" ? `\nAdemás, en el chat dame una guía de estudio breve y un quiz de ${Math.min(10, n)} preguntas con la clave al final.` : "") });
          return;
        }
        const que = { quiz: `un quiz de ${n} preguntas de opción múltiple (4 opciones, una correcta) con la clave de respuestas y una explicación breve de cada una AL FINAL`,
          tarjetas: `${n} tarjetas de estudio (pregunta → respuesta corta)`,
          guia: "una guía de estudio con conceptos clave, resumen por secciones, ejemplos y errores comunes",
          todo: `una guía de estudio breve, ${n} tarjetas de estudio y un quiz de ${n} preguntas de opción múltiple con la clave de respuestas al final` }[tipo];
        const formato = { chat: "Respóndelo aquí en el chat, bien organizado con Markdown.", nube: "Respóndelo aquí en el chat, bien organizado con Markdown.",
          pdf: "Entrégalo como PDF elegante para imprimir (preguntas primero y la clave de respuestas en una página aparte).",
          excel: "Entrégalo como Excel con columnas Pregunta y Respuesta (y Opciones si es quiz), listo para importar a Anki o Quizlet." }[salida];
        enviar({ mensaje: `Ayúdame a estudiar. Crea ${que}, para nivel ${f.get("nivel")}.\n${fuente} ${formato}` });
      });
  } else if (id === "correo") {
    const area = el("textarea", { name: "puntos", required: true });
    abrirDialogo("Redactar un correo", [
      el("label", {}, "Tipo de correo", selectorPlantilla("tipo", TIPOS_CORREO, area)),
      el("label", {}, "¿Para quién?", el("input", { type: "text", name: "para", placeholder: "Ej.: el rector, un cliente, mi jefe, la profesora Ana" })),
      el("label", {}, "¿Qué quieres decir? (puntos clave)", area),
      campoOpciones("tono", [["formal", "Formal"], ["cercano", "Cercano"], ["persuasivo", "Persuasivo"], ["directo", "Directo"]], "formal"),
      el("div", { class: "fila-2" }, el("div", {}, el("div", { class: "campo-titulo" }, "Extensión"), campoOpciones("largo", [["corto", "Corto"], ["medio", "Medio"], ["largo", "Largo"]], "medio")), campoNivel()),
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
      el("div", { class: "fila-2" }, el("div", {}, el("div", { class: "campo-titulo" }, "Extensión"), campoOpciones("largo", [["corto", "Corto"], ["medio", "Medio"], ["largo", "Largo"]], "medio")), campoNivel()),
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
      el("div", { class: "fila-2" }, el("label", {}, "Duración aproximada (segundos)", el("input", { type: "number", name: "duracion", min: 5, max: 90, value: 20 })), campoNivel()),
      el("div", { class: "campo-titulo" }, "Narración (voz)"),
      campoOpciones("motor", [["ninguna", "Sin voz"], ["chirp", "Voz natural"], ["gemini", "Voz expresiva"]], "chirp"),
      el("label", {}, "Voz", sel),
      el("label", {}, "Texto de la narración (opcional: si lo dejas vacío, Simbi lo escribe)", el("textarea", { name: "guion", placeholder: "Escribe exactamente lo que dirá la voz" })),
      el("label", {}, "Estilo de la voz (solo voz expresiva)", el("input", { type: "text", name: "estilo", placeholder: "Ej.: entusiasta, como profesor joven" })),
    ], `La voz se descuenta de tus minutos (te quedan ${(quedan("tts_chirp_seg", "tts_chirp_seg") / 60).toFixed(0)} min de voz natural y ${(quedan("tts_gemini_seg", "tts_gemini_seg") / 60).toFixed(0)} min de voz expresiva). ` +
      "Para música de fondo, adjunta un MP3 (＋) antes de crear. Recomendado: nivel Difícil o Muy complejo.", "Crear video",
      (f) => f.get("texto")?.trim() && enviar({ accion: "video_codigo", params: { texto: f.get("texto").trim(), formato: f.get("formato"),
        duracion: Math.min(90, Math.max(5, +f.get("duracion") || 20)), motor: f.get("motor"), voz: f.get("voz"),
        guion: f.get("guion") || "", estilo: f.get("estilo") || "" } }));
  }
}

/* ───────── ⏰ Recordatorios por Telegram (sin gastar tokens) ───────── */
async function abrirRecordatorios() {
  let datos;
  try { datos = await apiNube("/recordatorios"); } catch (e) { return alert(e.message); }
  if (!datos.telegram) {
    return abrirMisRecordatorios();
  }
  const dosDig = (n) => String(n).padStart(2, "0");
  const fechaLocal = (d) => `${d.getFullYear()}-${dosDig(d.getMonth() + 1)}-${dosDig(d.getDate())}`;
  const en1h = new Date(Date.now() + 3600e3);
  const fecha = el("input", { type: "date", name: "fecha", required: true, value: fechaLocal(en1h), min: fechaLocal(new Date()) });
  const hora = el("input", { type: "time", name: "hora", required: true, value: `${dosDig(en1h.getHours())}:00` });
  const poner = (d) => { fecha.value = fechaLocal(d); hora.value = `${dosDig(d.getHours())}:${dosDig(d.getMinutes())}`; };
  const manana = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d; };
  const rapidos = el("div", { class: "rapidos" },
    el("button", { type: "button", onclick: () => poner(new Date(Date.now() + 30 * 60e3)) }, "En 30 min"),
    el("button", { type: "button", onclick: () => poner(new Date(Date.now() + 3600e3)) }, "En 1 hora"),
    el("button", { type: "button", onclick: () => poner(manana(7)) }, "Mañana 7 a. m."),
    el("button", { type: "button", onclick: () => poner(manana(18)) }, "Mañana 6 p. m."));
  const pendientes = (datos.lista || []).filter((r) => !r.enviado);
  const lista = el("div", { class: "lista-rec" }, pendientes.map((r) => {
    const fila = el("div", {}, el("span", {}, r.texto, el("small", {}, new Date(r.cuando).toLocaleString("es-CO", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))),
      el("button", { type: "button", class: "btn-x", title: "Cancelar", onclick: async () => {
        try { await apiNube("/recordatorios/" + r.id, { method: "DELETE" }); fila.remove(); } catch (e) { alert(e.message); }
      } }, "✕"));
    return fila;
  }));
  abrirDialogo("Aviso por Telegram", [
    el("label", {}, "¿Qué te aviso?", el("textarea", { name: "texto", required: true, maxlength: 1000, placeholder: "Ej.: tomar el medicamento · pagar el arriendo · estudiar anatomía 30 min" })),
    el("div", { class: "fila-2" }, el("label", {}, "Fecha", fecha), el("label", {}, "Hora (Colombia)", hora)),
    rapidos,
    pendientes.length ? el("div", { class: "campo-titulo" }, `Pendientes (${pendientes.length})`) : null,
    pendientes.length ? lista : null,
  ], "Te llegará un mensaje de @SimbiAlertasBot a esa hora. También puedes pedírselo a Simbi en el chat: «avísame mañana a las 7 que llame a mamá».", "Programar",
    async (f) => {
      try {
        const r = await apiNube("/recordatorios", { method: "POST", body: JSON.stringify({ texto: f.get("texto").trim(), cuando: `${f.get("fecha")} ${f.get("hora")}` }) });
        alert("⏰ Listo: te aviso por Telegram el " + r.cuando + ".\n\nPuedes verlo o cambiarlo en ⏰ Avisos."); cargarRecsN();
      } catch (e) { alert("No se pudo programar: " + e.message); }
    });
}

/* 🌙/☀️ Tema: oscuro por defecto, claro opcional (se recuerda en este navegador) */
function pintarTema() {
  const claro = document.documentElement.dataset.theme === "light";
  $("btn-tema").textContent = claro ? "🌙 Modo oscuro" : "☀️ Modo claro";
  $("btn-tema").title = claro ? "Cambiar a modo oscuro" : "Cambiar a modo claro";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", claro ? "#F2F5F7" : "#0B0F14");
}
$("btn-tema").onclick = () => {
  const claro = document.documentElement.dataset.theme !== "light";
  if (claro) document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("simb_tema", claro ? "claro" : "oscuro"); } catch {}
  pintarTema();
};
pintarTema();

/* ⏰ Mis recordatorios: ver, cambiar y cancelar */
const fechaRec = (c) => new Date(c).toLocaleString("es-CO", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
async function cargarRecsN() {
  try {
    const d = await apiNube("/recordatorios");
    const n = (d.lista || []).filter((r) => !r.enviado).length;
    $("recs-n").textContent = n ? String(n) : "";
    return d;
  } catch { return null; }
}
async function abrirMisRecordatorios() {
  const dlg = $("dlg-recs"), c = $("recs-cont");
  if (!dlg.open) dlg.showModal();
  c.textContent = ""; c.append(el("div", { class: "vacio" }, "Cargando…"));
  const d = await cargarRecsN();
  c.textContent = "";
  if (!d) { c.append(el("div", { class: "vacio" }, "No se pudieron cargar. Intenta de nuevo.")); return; }
  const nuevo = el("button", { type: "button", class: "btn btn-brasa btn-chico", onclick: () => { dlg.close(); abrirRecordatorios(); } }, "＋ Nuevo aviso");
  Object.assign(tg, { conectado: d.telegram });
  if (!d.telegram) {
    c.append(el("div", { class: "tg-caja" },
      el("div", { class: "tg-cab" }, el("span", { class: "tg-ico" }, "✈️"), el("div", {}, el("b", {}, "Conecta Telegram para recibir tus avisos"),
        el("small", {}, "Solo una vez. Te llegarán por el bot @SimbiAlertasBot."))),
      el("ol", { class: "tg-pasos" },
        el("li", {}, "Toca ", el("b", {}, "Unirme al bot"), ": se abre Telegram."),
        el("li", {}, "En Telegram toca ", el("b", {}, "Iniciar"), " (o envía /start)."),
        el("li", {}, "Vuelve aquí: verás ", el("b", {}, "✅ Conectado"), ".")),
      el("div", { class: "tg-acc" },
        el("button", { type: "button", class: "btn btn-cian btn-chico", onclick: conectarTelegram }, "✈️ Unirme al bot"),
        el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: () => abrirMisRecordatorios() }, "Ya lo hice ↻"))));
  } else {
    await cargarTelegram();
    c.append(el("div", { class: "tg-caja ok" },
      el("div", { class: "tg-cab" }, el("span", { class: "tg-ico" }, "✅"), el("div", {}, el("b", {}, "Telegram conectado" + (tg.usuario ? " · " + tg.usuario : "")),
        el("small", {}, "Aquí te llegan tus avisos, el mensaje cuando Simbi termina algo largo y los datos de tus webs."))),
      el("div", { class: "tg-acc" },
        el("a", { class: "btn btn-borde btn-chico", href: "https://t.me/SimbiAlertasBot", target: "_blank", rel: "noopener" }, "Abrir el bot"),
        el("button", { type: "button", class: "enlace", onclick: async () => { if (await desconectarTelegram()) abrirMisRecordatorios(); } }, "Desconectar"))));
  }
  const pend = (d.lista || []).filter((r) => !r.enviado).sort((a, b) => new Date(a.cuando) - new Date(b.cuando));
  const env = (d.lista || []).filter((r) => r.enviado);
  c.append(el("div", { class: "recs-cab" }, el("b", {}, pend.length ? `Pendientes (${pend.length})` : "No tienes avisos pendientes"), esPro() ? nuevo : null));
  if (!esPro() && !pend.length) c.append(el("small", { class: "nota" }, "Programar avisos por Telegram es parte de la versión Pro."));
  const lista = el("div", { class: "recs-lista" });
  for (const r of pend) lista.append(filaRec(r));
  c.append(lista);
  if (env.length) c.append(el("details", { class: "recs-env" }, el("summary", {}, `Ya enviados (${env.length})`),
    el("div", { class: "recs-lista" }, env.map((r) => el("div", { class: "rec-fila enviado" },
      el("div", { class: "rec-txt" }, el("span", {}, r.texto), el("small", {}, (r.resultado && r.resultado !== "ok" ? "⚠️ No se pudo enviar · " : "✅ Enviado · ") + fechaRec(r.cuando))))))));
}
function filaRec(r) {
  const fila = el("div", { class: "rec-fila" });
  const ver = () => {
    fila.textContent = "";
    fila.append(el("div", { class: "rec-txt" }, el("span", {}, r.texto), el("small", {}, "🕑 " + fechaRec(r.cuando))),
      el("div", { class: "rec-acc" },
        el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: editar }, "✏️ Cambiar"),
        el("button", { type: "button", class: "btn-x", title: "Cancelar aviso", onclick: async () => {
          if (!confirm(`¿Cancelar «${r.texto.slice(0, 60)}»?`)) return;
          try { await apiNube("/recordatorios/" + r.id, { method: "DELETE" }); fila.remove(); cargarRecsN(); } catch (e) { alert(e.message); }
        } }, "✕")));
  };
  const editar = () => {
    const dd = (n) => String(n).padStart(2, "0"), f = new Date(r.cuando);
    const texto = el("textarea", { maxlength: 1000, rows: 2 }); texto.value = r.texto;
    const fecha = el("input", { type: "date", value: `${f.getFullYear()}-${dd(f.getMonth() + 1)}-${dd(f.getDate())}` });
    const hora = el("input", { type: "time", value: `${dd(f.getHours())}:${dd(f.getMinutes())}` });
    const guardar = el("button", { type: "button", class: "btn btn-brasa btn-chico", onclick: async () => {
      if (!texto.value.trim() || !fecha.value || !hora.value) return alert("Completa el texto, la fecha y la hora.");
      guardar.disabled = true;
      try {
        const res = await apiNube("/recordatorios/" + r.id, { method: "POST", body: JSON.stringify({ texto: texto.value.trim(), cuando: `${fecha.value} ${hora.value}` }) });
        r.texto = texto.value.trim(); r.cuando = new Date(`${fecha.value}T${hora.value}:00-05:00`).toISOString();
        ver(); fila.querySelector(".rec-txt small").textContent = "✅ Cambiado · te aviso el " + res.cuando;
      } catch (e) { alert(e.message); guardar.disabled = false; }
    } }, "Guardar");
    fila.textContent = "";
    fila.append(el("div", { class: "rec-edit" }, texto, el("div", { class: "fila-2" }, fecha, hora),
      el("div", { class: "rec-acc" }, guardar, el("button", { type: "button", class: "btn btn-borde btn-chico", onclick: ver }, "Cancelar"))));
    texto.focus();
  };
  ver();
  return fila;
}
$("btn-recs").onclick = () => abrirMisRecordatorios();

function etiquetaAccion(accion, p) {
  return ({ imagen: "🎨 Imagen: ", video: "🎬 Video IA: ", voz_chirp: "🔊 Voz natural: ", voz_gemini: "🔊 Voz expresiva: ",
    youtube_mp4: "⬇️ YouTube MP4: ", youtube_mp3: "🎵 YouTube MP3: ", redes_mp4: "📲 Descargar de redes: ", redes_mp3: "🎵 Audio de redes: ", transcribir: "📝 Transcribir: ", video_codigo: "🎞️ Video con código: " })[accion] +
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
