"use strict";
// Progressive enhancement: copy, pricing, language links and FAQs work without JS.
const demo = document.getElementById("demo-play");
if (demo) {
  demo.hidden = false;
  demo.addEventListener("click", async () => {
    if (demo.disabled) return;
    demo.disabled = true;
    const rows = [...document.querySelectorAll("[data-demo-row]")];
    const live = document.getElementById("demo-announcement");
    live.textContent = "";
    for (const row of rows) {
      row.classList.remove("is-sent", "is-sending");
      row.querySelector("[data-demo-status]").textContent = demo.dataset.idle;
    }
    const delay = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450;
    for (const row of rows) {
      row.classList.add("is-sending");
      row.querySelector("[data-demo-status]").textContent = demo.dataset.sending;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      row.classList.replace("is-sending", "is-sent");
      row.querySelector("[data-demo-status]").textContent = demo.dataset.sent;
    }
    live.textContent = demo.dataset.complete;
    demo.querySelector("span").textContent = demo.dataset.replay;
    demo.disabled = false;
  });
}
const openLinkedDetails = () => {
  if (location.hash === "#promotion-terms") {
    const terms = document.getElementById("promotion-terms");
    if (terms) terms.open = true;
  }
};
document.querySelectorAll('a[href="#promotion-terms"]').forEach(link => link.addEventListener("click", () => {
  const terms = document.getElementById("promotion-terms");
  if (terms) terms.open = true;
}));
window.addEventListener("hashchange", openLinkedDetails);
openLinkedDetails();
