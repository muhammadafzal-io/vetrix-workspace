/*
 * Booking widget loader. A clinic adds one line to its website:
 *   <script src="https://APP/widget.js" data-clinic="clinic-slug" async></script>
 * Optional: data-label="Book a visit", data-color="#0f766e" (a dark colour, 6 digits),
 * data-position="left", data-launcher="none" (no floating button; use links),
 * data-location="<location id>" (clinics with several locations),
 * data-mode="modal" (open centred over a dimmed page instead of beside the button).
 * It adds a floating button that opens the clinic's booking panel in a frame.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.__clinicBookingWidget) return;
  window.__clinicBookingWidget = true;

  var slug = script.getAttribute("data-clinic") || "";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    console.warn("Booking widget: add data-clinic with your clinic's link name.");
    return;
  }
  var base = new URL(script.src).origin;
  var label = script.getAttribute("data-label") || "Book a visit";
  var color = script.getAttribute("data-color") || "#0f766e";
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = "#0f766e";
  var left = script.getAttribute("data-position") === "left";
  var loc = script.getAttribute("data-location") || "";
  var custom = script.getAttribute("data-color") && color.toLowerCase() !== "#0f766e";
  var src = base + "/w/" + slug + "?embed=1" + (/^[0-9a-f-]{36}$/i.test(loc) ? "&l=" + loc : "") + (custom ? "&color=" + color.slice(1) : "");
  var launcher = script.getAttribute("data-launcher") !== "none";
  var modal = script.getAttribute("data-mode") === "modal";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var side = left ? "left" : "right";

  var font = "600 15px/1.2 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
  var style = document.createElement("style");
  style.textContent =
    ".cbw-btn{position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;display:flex;align-items:center;gap:10px;" +
    "height:52px;padding:0 20px 0 16px;border:0;border-radius:999px;background:" + color + ";color:#fff;font:" + font + ";" +
    "box-shadow:0 10px 28px -6px rgba(15,23,42,.35),0 2px 6px rgba(15,23,42,.12);cursor:pointer" +
    (reduce ? "" : ";transition:transform .18s ease,box-shadow .18s ease") + "}" +
    ".cbw-btn:hover{transform:translateY(-1px);box-shadow:0 14px 32px -6px rgba(15,23,42,.4),0 2px 6px rgba(15,23,42,.12)}" +
    ".cbw-btn:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 6px " + color + "}" +
    ".cbw-btn svg{width:22px;height:22px;flex:none}" +
    ".cbw-btn .cbw-x{display:none}.cbw-btn[aria-expanded=true] .cbw-x{display:block}.cbw-btn[aria-expanded=true] .cbw-cal{display:none}" +
    ".cbw-btn[aria-expanded=true]{padding:0;width:52px;justify-content:center}.cbw-btn[aria-expanded=true] .cbw-label{display:none}" +
    ".cbw-panel{position:fixed;bottom:88px;" + side + ":20px;z-index:2147483001;width:400px;height:min(700px,calc(100vh - 112px));" +
    "border:0;border-radius:20px;background:#fff;box-shadow:0 24px 64px -12px rgba(15,23,42,.35),0 0 0 1px rgba(15,23,42,.06);" +
    "opacity:0;transform:translateY(16px) scale(.98);transform-origin:bottom " + side + ";pointer-events:none;visibility:hidden" +
    (reduce ? "" : ";transition:opacity .2s ease,transform .24s cubic-bezier(.22,1,.36,1),visibility .2s") + "}" +
    ".cbw-panel.cbw-open{opacity:1;transform:none;pointer-events:auto;visibility:visible}" +
    ".cbw-modal{top:50%;bottom:auto;left:50%;right:auto;width:420px;height:min(720px,calc(100vh - 48px));transform:translate(-50%,calc(-50% + 16px)) scale(.98);transform-origin:center}" +
    ".cbw-modal.cbw-open{transform:translate(-50%,-50%)}" +
    ".cbw-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(6,19,37,.55);opacity:0;visibility:hidden" +
    (reduce ? "" : ";backdrop-filter:blur(3px);transition:opacity .2s ease,visibility .2s") + "}" +
    ".cbw-backdrop.cbw-open{opacity:1;visibility:visible}" +
    "@media (max-width:480px){.cbw-panel,.cbw-modal,.cbw-modal.cbw-open{inset:0;width:100%;height:100%;border-radius:0;transform:none}.cbw-panel.cbw-open~.cbw-btn{display:none}}";
  document.head.appendChild(style);

  var frame = null;
  var backdrop = null;
  var button = document.createElement("button");
  button.type = "button";
  button.className = "cbw-btn";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", label);
  var svg = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  button.innerHTML =
    '<svg class="cbw-cal" ' + svg + '><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/></svg>' +
    '<svg class="cbw-x" ' + svg + '><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var text = document.createElement("span");
  text.className = "cbw-label";
  text.textContent = label;
  button.appendChild(text);

  function open() {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "cbw-panel" + (modal ? " cbw-modal" : "");
      if (modal) {
        backdrop = document.createElement("div");
        backdrop.className = "cbw-backdrop";
        backdrop.addEventListener("click", close);
        document.body.appendChild(backdrop);
      }
      frame.title = label;
      frame.src = src;
      frame.setAttribute("allow", "clipboard-write");
      document.body.appendChild(frame);
      if (button.parentNode) document.body.appendChild(button);
      // Let the frame paint before sliding in.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          frame.classList.add("cbw-open");
          if (backdrop) backdrop.classList.add("cbw-open");
        });
      });
    } else {
      frame.classList.add("cbw-open");
      if (backdrop) backdrop.classList.add("cbw-open");
    }
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-label", "Close " + label.toLowerCase());
  }
  function close() {
    if (frame) frame.classList.remove("cbw-open");
    if (backdrop) backdrop.classList.remove("cbw-open");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", label);
    if (button.parentNode) button.focus();
  }
  button.addEventListener("click", function () {
    if (frame && frame.classList.contains("cbw-open")) close();
    else open();
  });
  window.addEventListener("message", function (e) {
    if (e.origin === base && e.data && e.data.type === "booking-widget:close") close();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && frame && frame.classList.contains("cbw-open")) close();
  });
  // Any link on the site can open it: <a href="#book" data-booking-widget>Book</a>
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest && e.target.closest("[data-booking-widget]");
    if (t) {
      e.preventDefault();
      open();
    }
  });

  function mount() {
    if (launcher) document.body.appendChild(button);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
