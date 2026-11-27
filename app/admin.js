import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { CONFIG } from "../config.js";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const raiz = document.getElementById("contenido");
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("es-CO");
function el(tag, attrs = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const h of hijos.flat()) if (h != null) n.append(h.nodeType ? h : document.createTextNode(String(h)));
  return n;
}

let usuarios = [];
let yo = null;

async function iniciar() {
  const { data: s } = await sb.auth.getSession();
  if (!s.session) { location.href = "./"; return; }
  yo = s.session.user.id;
  const { data: esAdmin } = await sb.rpc("es_admin");
  if (!esAdmin) { raiz.replaceChildren(el("p", { class: "aviso" }, "Esta página es solo para administradores.")); return; }
  await pintar();
}

async function pintar() {
  const [{ data: res }, { data: us, error }, { data: planes }, { data: sugs }, { data: intz }, avisos] = await Promise.all([
    sb.rpc("admin_resumen"), sb.rpc("admin_usuarios"), sb.from("planes").select("*").order("plan"), sb.rpc("admin_sugerencias"),
    sb.rpc("admin_interesados"), api("/admin/avisos").catch((e) => ({ error: e.message })),
  ]);
  if (error) { raiz.replaceChildren(el("p", { class: "aviso" }, error.message)); return; }
  usuarios = us || [];
  const sem = res?.semana || {};
  const kpis = el("div", { class: "kpis" },
    kpi("Usuarios", fmt(res?.usuarios)), kpi("Pro", fmt(res?.pro)),
    kpi("Tokens esta semana", fmt(sem.chat)), kpi("Imágenes", fmt(sem.imagen)), kpi("Videos", fmt(sem.video)),
    kpi("Voz (min)", fmt(((Number(sem.tts_chirp) || 0) + (Number(sem.tts_gemini) || 0)) / 60)),
    kpi("Transcripción (min)", fmt((Number(sem.stt) || 0) / 60)));
  const modelos = Object.entries(res?.modelos || {}).map(([m, t]) => `${m}: ${fmt(t)}`).join(" · ");

  const buscar = el("input", { type: "search", placeholder: "Buscar por correo o nombre…" });
  const filtro = el("select", {}, el("option", { value: "" }, "Todos"), el("option", { value: "pro" }, "Solo Pro"), el("option", { value: "gratis" }, "Solo Gratis"));
  const cuerpo = el("tbody");
  const refrescar = () => pintarFilas(cuerpo, buscar.value.trim().toLowerCase(), filtro.value);
  buscar.oninput = refrescar; filtro.onchange = refrescar;
  refrescar();

  raiz.replaceChildren(
    kpis,
    modelos ? el("p", { class: "mono" }, "Modelos usados esta semana (tokens) — " + modelos) : "",
    el("h2", {}, `Quieren Pro (${(intz || []).filter((x) => !x.atendido).length} por atender)`),
    seccionInteresados(intz || []),
    el("h2", { id: "avisos" }, `📣 Difusión por Telegram (${avisos?.conectados ?? 0} conectados)`),
    seccionAvisos(avisos),
    el("h2", {}, `Sugerencias (${(sugs || []).filter((x) => x.estado === "nueva").length} nuevas)`),
    seccionSugerencias(sugs || []),
    el("h2", {}, "Usuarios"),
    el("div", { class: "herr" }, buscar, filtro),
    el("div", { class: "tabla" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Usuario", "Plan", "Rol", "Prueba", "Tokens semana", "Imágenes", "Videos", "Voz (min)", "Chats", "Último ingreso"].map((t) => el("th", {}, t)))),
      cuerpo)),
    el("h2", {}, "Límites semanales por plan"),
    el("div", { class: "planes" }, (planes || []).map(formPlan)),
    seccionAccesos(),
  );
}

function kpi(t, v) { return el("div", { class: "kpi" }, el("small", {}, t), el("b", {}, v)); }

function pintarFilas(tbody, q, plan) {
  tbody.textContent = "";
  for (const u of usuarios) {
    if (q && !`${u.correo} ${u.nombre || ""}`.toLowerCase().includes(q)) continue;
    if (plan && u.plan !== plan) continue;
    tbody.append(el("tr", {},
      el("td", {}, el("div", { class: "correo" }, u.correo), u.nombre ? el("div", { class: "nombre" }, u.nombre) : null),
      el("td", {}, interruptor(u, "plan", [["gratis", "Gratis"], ["pro", "Pro"]])),
      el("td", {}, interruptor(u, "rol", [["usuario", "Usuario"], ["admin", "Admin"]])),
      el("td", {}, celdaPrueba(u)),
      el("td", { class: "num" }, fmt(u.chat_tokens)),
      el("td", { class: "num" }, fmt(u.imagenes)),
      el("td", { class: "num" }, fmt(u.videos)),
      el("td", { class: "num" }, fmt(u.tts_seg / 60)),
      el("td", {}, Number(u.conversaciones) ? el("button", { type: "button", class: "btn-mini", title: "Ver sus chats (solo lectura)", onclick: () => verChats(u) }, "👁️ " + fmt(u.conversaciones)) : el("span", { class: "num" }, "0")),
      el("td", { class: "num" }, u.ultimo_ingreso ? new Date(u.ultimo_ingreso).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) : "—")));
  }
}

function celdaPrueba(u) {
  if (!u.prueba_termina) return "—";
  const fin = new Date(u.prueba_termina), vencida = fin <= new Date();
  const btn = el("button", { type: "button", class: "btn-mini", title: "Da otro día de prueba desde ahora",
    onclick: async () => {
      if (!confirm(`¿Reiniciar el día de prueba de ${u.correo}?`)) return;
      const { error } = await sb.rpc("admin_reiniciar_prueba", { p_uid: u.id });
      if (error) return alert(error.message);
      await pintar();
    } }, "Reiniciar");
  return el("div", { class: "celda-prueba" },
    el("span", { class: vencida ? "vencida" : "activa" }, (vencida ? "Vencida " : "Hasta ") + fin.toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })), btn);
}

function interruptor(u, campo, opciones) {
  const cont = el("div", { class: "interruptor" });
  const pintarB = () => {
    cont.textContent = "";
    for (const [v, t] of opciones) {
      cont.append(el("button", { type: "button", class: (u[campo] === v ? "on " : "") + v, disabled: campo === "rol" && u.id === yo,
        onclick: async () => {
          if (u[campo] === v) return;
          if (campo === "rol" && v === "admin" && !confirm(`¿Dar rol de administrador a ${u.correo}?`)) return;
          const fn = campo === "plan" ? "admin_poner_plan" : "admin_poner_rol";
          const { error } = await sb.rpc(fn, campo === "plan" ? { p_uid: u.id, p_plan: v } : { p_uid: u.id, p_rol: v });
          if (error) return alert(error.message);
          u[campo] = v; pintarB();
        } }, t));
    }
  };
  pintarB();
  return cont;
}

const CAMPOS = [
  ["chat_tokens", "Tokens de chat"], ["imagenes", "Imágenes"], ["videos", "Videos"], ["video_seg_max", "Segundos por video (máx.)"],
  ["tts_gemini_seg", "Voz expresiva (segundos)"], ["tts_chirp_seg", "Voz natural (segundos)"], ["stt_seg", "Transcripción (segundos)"], ["musica", "Música (canciones de 30 s)"], ["descargas", "Descargas (YouTube y redes)"],
  ["prueba_horas", "Horas de prueba (0 = sin vencimiento)"], ["nube_gb", "Mi nube (GB por usuario)"],
];
const GB = 1073741824;
function formPlan(p) {
  const estadoOk = el("span", { class: "ok" });
  const inputs = Object.fromEntries(CAMPOS.map(([k]) => [k, k === "nube_gb"
    ? el("input", { type: "number", min: "0", step: "0.5", value: +((p.nube_bytes || 0) / GB).toFixed(2) })
    : el("input", { type: "number", min: "0", value: p[k] ?? 0 })]));
  return el("form", { class: "plan", onsubmit: async (e) => {
    e.preventDefault();
    const datos = Object.fromEntries(Object.entries(inputs).map(([k, i]) => k === "nube_gb"
      ? ["nube_bytes", Math.round((Number(i.value) || 0) * GB)] : [k, Number(i.value) || 0]));
    const { error } = await sb.rpc("admin_editar_plan", { p_plan: p.plan, p_datos: datos });
    estadoOk.textContent = error ? error.message : "Guardado ✓";
    setTimeout(() => (estadoOk.textContent = ""), 2500);
  } },
    el("h3", {}, p.plan === "pro" ? "Pro" : "Gratis"),
    el("p", { class: "mono", style: "margin:0 0 12px" }, "Niveles: " + (p.niveles || []).join(", ")),
    CAMPOS.map(([k, t]) => el("label", {}, t, inputs[k])),
    el("div", {}, el("button", { class: "btn btn-cian", type: "submit" }, "Guardar"), estadoOk));
}

iniciar();

function seccionSugerencias(lista) {
  if (!lista.length) return el("p", { class: "mono" }, "Aún no hay sugerencias.");
  const ICO = { idea: "💡", problema: "🐞", otro: "💬" };
  const filtro = el("select", {}, el("option", { value: "nueva" }, "Nuevas"), el("option", { value: "" }, "Todas"),
    el("option", { value: "revisada" }, "Revisadas"), el("option", { value: "hecha" }, "Hechas"));
  const cont = el("div", { class: "sugs" });
  const pintarS = () => {
    const vis = lista.filter((x) => !filtro.value || x.estado === filtro.value);
    cont.replaceChildren(...(vis.length ? vis.map((x) => {
      const est = el("select", { class: "est-sug" }, ["nueva", "revisada", "hecha"].map((e) => el("option", { value: e, selected: e === x.estado ? true : null }, e)));
      est.onchange = async () => {
        const { error } = await sb.rpc("admin_estado_sugerencia", { p_id: x.id, p_estado: est.value });
        if (error) { alert(error.message); est.value = x.estado; return; }
        x.estado = est.value; pintarS();
      };
      return el("div", { class: "sug " + x.estado },
        el("div", { class: "sug-cab" }, el("b", {}, `${ICO[x.tipo] || "💬"} ${x.nombre || x.correo || "Usuario"}`),
          el("small", {}, `${x.correo || ""} · ${new Date(x.creado).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}`), est),
        el("p", {}, x.texto));
    }) : [el("p", { class: "mono" }, "Nada en este filtro.")]));
  };
  filtro.onchange = pintarS; pintarS();
  return el("div", {}, el("div", { class: "herr" }, filtro), cont);
}


/* ───── API del servidor (avisos) ───── */
async function api(ruta, opciones = {}) {
  const { data: s } = await sb.auth.getSession();
  const r = await fetch(CONFIG.API_URL + ruta, { ...opciones, headers: { Authorization: "Bearer " + s.session?.access_token,
    ...(opciones.body ? { "Content-Type": "application/json" } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `Error ${r.status}`);
  return j;
}
const fechaCO = (f) => new Date(f).toLocaleString("es-CO", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/* ───── 💰 Interesados en Pro (dejaron su WhatsApp) ───── */
function seccionInteresados(lista) {
  if (!lista.length) return el("p", { class: "mono" }, "Aún nadie ha pedido Pro desde la app.");
  return el("div", { class: "tabla" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Fecha", "Correo", "WhatsApp", "Quería usar", "Atendido"].map((t) => el("th", {}, t)))),
    el("tbody", {}, lista.map((x) => {
      const num = String(x.whatsapp || "").replace(/[^\d]/g, "");
      const chk = el("input", { type: "checkbox", ...(x.atendido ? { checked: "" } : {}) });
      chk.onchange = async () => {
        const { error } = await sb.rpc("admin_atender_interesado", { p_id: x.id, p_atendido: chk.checked });
        if (error) { alert(error.message); chk.checked = !chk.checked; }
      };
      return el("tr", {}, el("td", { class: "num" }, fechaCO(x.creado)), el("td", {}, x.correo || "—"),
        el("td", {}, el("a", { href: `https://wa.me/${num}?text=${encodeURIComponent("Hola 👋, te escribo de Somos Simbióticos por tu solicitud de Simbi Pro.")}`, target: "_blank", rel: "noopener" }, "💬 " + x.whatsapp)),
        el("td", {}, x.motivo || "—"), el("td", {}, chk));
    }))));
}

/* ───── 📣 Avisos por Telegram a todos los conectados ───── */
function seccionAvisos(datos) {
  if (datos?.error) return el("p", { class: "aviso" }, "No se pudo cargar: " + datos.error);
  const texto = el("textarea", { rows: "4", maxlength: "3500", placeholder: "Mensaje para todos los que conectaron Telegram… (puedes usar <b>negrita</b>)", style: "width:100%;background:var(--ink);border:1px solid var(--linea);border-radius:12px;padding:10px 14px;color:var(--papel)" });
  const cuando = el("input", { type: "datetime-local", title: "Vacío = enviar ahora (hora de Colombia)" });
  const ok = el("span", { class: "ok" });
  const boton = el("button", { type: "button", class: "btn btn-brasa" }, "Enviar / programar");
  boton.onclick = async () => {
    if (!texto.value.trim()) return;
    if (!confirm(cuando.value ? "¿Programar este aviso?" : `¿Enviar AHORA a ${datos.conectados} personas?`)) return;
    boton.disabled = true;
    try {
      const r = await api("/admin/avisos", { method: "POST", body: JSON.stringify({ texto: texto.value, cuando: cuando.value ? cuando.value.replace("T", " ") : null }) });
      ok.textContent = "✓ " + (cuando.value ? "Programado para el " + r.cuando : "Enviado"); texto.value = ""; cuando.value = "";
      setTimeout(pintar, 1500);
    } catch (e) { alert(e.message); } finally { boton.disabled = false; }
  };
  const filas = (datos?.avisos || []).map((a) => el("tr", {},
    el("td", { class: "num" }, fechaCO(a.cuando)),
    el("td", { style: "white-space:normal;max-width:520px" }, a.texto.replace(/<[^>]+>/g, "").slice(0, 180)),
    el("td", {}, a.enviado ? (a.resultado || "enviado") : "⏳ pendiente"),
    el("td", {}, a.enviado ? "" : el("button", { type: "button", class: "btn-mini", onclick: async () => {
      if (!confirm("¿Cancelar este aviso?")) return;
      try { await api("/admin/avisos/" + a.id, { method: "DELETE" }); pintar(); } catch (e) { alert(e.message); }
    } }, "Cancelar"))));
  return el("div", {},
    el("p", { class: "mono" }, "Les llega a quienes conectaron Telegram en Simbi (⏰ Recordatorios). Deja la fecha vacía para enviarlo ya (hora de Colombia)."),
    texto, el("div", { class: "herr", style: "margin-top:10px;align-items:center" }, cuando, boton, ok),
    filas.length ? el("div", { class: "tabla" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Cuándo", "Mensaje", "Estado", ""].map((t) => el("th", {}, t)))), el("tbody", {}, filas))) : null);
}


/* ───── 👁️ Ver los chats de un usuario (solo lectura; cada apertura queda registrada) ───── */
const fechaCorta = (f) => new Date(f).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
const NIVEL = { facil: "Fácil", medio: "Medio", dificil: "Difícil", complejo: "Muy complejo" };
let dlg = null;
async function verChats(u) {
  if (!dlg) { dlg = el("dialog", { class: "chats", "aria-label": "Chats del usuario" }); document.body.append(dlg);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); }
  const lista = el("div", { class: "ch-lista" }, el("p", { class: "mono" }, "Cargando…"));
  const vista = el("div", { class: "ch-vista" }, el("p", { class: "mono" }, "Elige una conversación."));
  dlg.replaceChildren(
    el("div", { class: "ch-cab" },
      el("div", {}, el("b", {}, "💬 Chats de " + (u.nombre || u.correo)), el("small", {}, u.correo + " · solo lectura · cada chat que abras queda registrado")),
      el("button", { type: "button", class: "btn-mini", onclick: () => dlg.close(), "aria-label": "Cerrar" }, "✕ Cerrar")),
    el("div", { class: "ch-cuerpo" }, lista, vista));
  dlg.showModal();
  const { data, error } = await sb.rpc("admin_conversaciones", { p_uid: u.id });
  if (error) { lista.replaceChildren(el("p", { class: "aviso" }, error.message)); return; }
  if (!data?.length) { lista.replaceChildren(el("p", { class: "mono" }, "No tiene conversaciones.")); return; }
  const botones = data.map((c) => el("button", { type: "button", class: "ch-conv", onclick: (e) => {
      botones.forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on"); abrirChat(c, vista);
      dlg.querySelector(".ch-cuerpo").classList.add("abierto");
    } },
    el("b", {}, c.titulo || "Sin título"), el("small", {}, `${fechaCorta(c.actualizado)} · ${fmt(c.mensajes)} mensajes · ${NIVEL[c.nivel] || c.nivel}`)));
  lista.replaceChildren(...botones);
}
async function abrirChat(c, vista) {
  vista.replaceChildren(el("p", { class: "mono" }, "Cargando…"));
  const { data, error } = await sb.rpc("admin_mensajes", { p_conv: c.id });
  if (error) { vista.replaceChildren(el("p", { class: "aviso" }, error.message)); return; }
  const volver = el("button", { type: "button", class: "btn-mini ch-volver", onclick: () => dlg.querySelector(".ch-cuerpo").classList.remove("abierto") }, "← Conversaciones");
  const msjs = (data || []).map((m) => {
    const adj = (m.adjuntos || []).map((a) => el("span", { class: "ch-adj" }, (/^image\//.test(a.mime) ? "🖼️ " : /^audio\//.test(a.mime) ? "🎵 " : /^video\//.test(a.mime) ? "🎬 " : "📎 ") + (a.nombre || a.ruta || "archivo")));
    const herr = (m.eventos || []).map((e) => e && (e.etiqueta || e.nombre || e.herramienta || e.tipo)).filter(Boolean);
    const pie = [fechaCorta(m.creado), m.rol === "asistente" && m.modelo ? m.modelo + (m.detalle ? " · " + m.detalle : "") : null,
      m.tokens ? fmt(m.tokens) + " tokens" : null, herr.length ? [...new Set(herr)].join(", ") : null].filter(Boolean).join(" · ");
    return el("div", { class: "ch-msj " + (m.rol === "usuario" ? "yo" : "ia") },
      el("div", { class: "ch-quien" }, m.rol === "usuario" ? "👤 Usuario" : "🤖 Simbi"),
      m.contenido ? el("div", { class: "ch-texto" }, m.contenido) : null,
      adj.length ? el("div", { class: "ch-adjs" }, adj) : null,
      el("small", {}, pie));
  });
  vista.replaceChildren(volver, el("h3", {}, c.titulo || "Sin título"), ...(msjs.length ? msjs : [el("p", { class: "mono" }, "Sin mensajes.")]));
  vista.scrollTop = 0;
}

/* ───── Registro de accesos a chats ───── */
function seccionAccesos() {
  const cont = el("div", {}, el("p", { class: "mono" }, "Cargando…"));
  const det = el("details", { class: "accesos" }, el("summary", {}, "🔒 Registro: quién vio qué chat"), cont);
  det.addEventListener("toggle", async () => {
    if (!det.open) return;
    const { data, error } = await sb.rpc("admin_accesos_recientes");
    if (error) return cont.replaceChildren(el("p", { class: "aviso" }, error.message));
    if (!data?.length) return cont.replaceChildren(el("p", { class: "mono" }, "Nadie ha abierto chats todavía."));
    cont.replaceChildren(el("div", { class: "tabla" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Cuándo", "Administrador", "Usuario", "Chat"].map((t) => el("th", {}, t)))),
      el("tbody", {}, data.map((a) => el("tr", {}, el("td", { class: "num" }, fechaCorta(a.creado)), el("td", {}, a.admin || "—"),
        el("td", {}, a.usuario || "—"), el("td", {}, a.titulo || "(borrado)")))))));
  });
  return det;
}
