if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js?v=30").catch(() => {});

window.addEventListener("error", (event) => {
  if (!String(event.filename || "").includes("app.js")) return;
  console.error("Application startup failure", event.filename, event.lineno, event.colno, event.error);
  const message = document.querySelector("[data-storage-message]");
  const dot = document.querySelector("[data-storage-dot]");
  const root = document.querySelector("[data-app]");
  if (message) message.textContent = "The application update could not start. Reload to try the current local version.";
  if (dot) dot.dataset.state = "error";
  if (!root) return;
  root.textContent = "";
  const section = document.createElement("section");
  const heading = document.createElement("h1");
  const text = document.createElement("p");
  const button = document.createElement("button");
  section.className = "empty-state";
  heading.textContent = "Application update needs attention";
  text.textContent = "Your private device data has not been changed.";
  button.className = "button";
  button.type = "button";
  button.textContent = "Reload application";
  button.addEventListener("click", () => location.reload());
  section.append(heading, text, button);
  root.append(section);
});
