(() => {
  "use strict";
  const tg = window.Telegram?.WebApp;
  if (!tg?.initData) return;
  tg.ready(); tg.expand();
  const close = () => tg.close();
  document.querySelector(".guide-footer").hidden = false;
  document.querySelector("#close-guide").addEventListener("click", close);
  tg.BackButton?.show(); tg.BackButton?.onClick(close);
})();
