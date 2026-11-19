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
  const [{ data: res }, { data: us, error }, { data: planes }] = await Promise.all([
    sb.rpc("admin_resumen"), sb.rpc("admin_usuarios"), sb.from("planes").select("*").order("plan"),
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
    modelos ? el("p", { class: "mono" }, "Modelos usados esta semana (tokens) — " + modelos) : null,
    el("h2", {}, "Usuarios"),
    el("div", { class: "herr" }, buscar, filtro),
    el("div", { class: "tabla" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Usuario", "Plan", "Rol", "Tokens semana", "Imágenes", "Videos", "Voz (min)", "Chats", "Último ingreso"].map((t) => el("th", {}, t)))),
      cuerpo)),
    el("h2", {}, "Límites semanales por plan"),
    el("div", { class: "planes" }, (planes || []).map(formPlan)),
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
      el("td", { class: "num" }, fmt(u.chat_tokens)),
      el("td", { class: "num" }, fmt(u.imagenes)),
      el("td", { class: "num" }, fmt(u.videos)),
      el("td", { class: "num" }, fmt(u.tts_seg / 60)),
      el("td", { class: "num" }, fmt(u.conversaciones)),
      el("td", { class: "num" }, u.ultimo_ingreso ? new Date(u.ultimo_ingreso).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) : "—")));
  }
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
  ["tts_gemini_seg", "Voz Gemini (segundos)"], ["tts_chirp_seg", "Voz Chirp (segundos)"], ["stt_seg", "Transcripción (segundos)"],
];
function formPlan(p) {
  const estadoOk = el("span", { class: "ok" });
  const inputs = Object.fromEntries(CAMPOS.map(([k]) => [k, el("input", { type: "number", min: "0", value: p[k] ?? 0 })]));
  return el("form", { class: "plan", onsubmit: async (e) => {
    e.preventDefault();
    const datos = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, Number(i.value) || 0]));
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
