// Log panel at the bottom of the page.

export function createLog(el) {
  return (msg) => {
    el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  };
}
