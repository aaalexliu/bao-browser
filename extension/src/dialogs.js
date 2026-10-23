// Accept page dialogs so a confirm() cannot stall a replay. This is not a navigator patch.
(() => {
  if (window.__baoDialogs) return;
  window.__baoDialogs = true;
  window.alert = function () {};
  window.confirm = function () { return true; };
  window.prompt = function (_message, value) {
    if (typeof window.__baoPromptAnswer === "string") return window.__baoPromptAnswer;
    return value == null ? "" : String(value);
  };
})();
