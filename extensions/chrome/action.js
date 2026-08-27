const state = document.querySelector("#state");
const onboarding = document.querySelector("#onboarding");
const statusPanel = document.querySelector("#status-panel");
const consent = document.querySelector("#consent");
const enable = document.querySelector("#enable");
const disable = document.querySelector("#disable");

consent.addEventListener("change", () => {
  enable.disabled = !consent.checked;
});
enable.addEventListener("click", () => void setConsent(true));
disable.addEventListener("click", () => void setConsent(false));

async function setConsent(value) {
  enable.disabled = true;
  disable.disabled = true;
  const next = await chrome.runtime.sendMessage({
    type: "action:set-consent",
    value,
  });
  render(next);
}

function render(status) {
  onboarding.hidden = status.consented;
  statusPanel.hidden = !status.consented;
  document.querySelector("#version").textContent = status.version;

  if (!status.consented) {
    state.className = "pill disabled";
    state.textContent = "Setup required";
    consent.checked = false;
    enable.disabled = true;
    return;
  }

  disable.disabled = false;
  const connection = document.querySelector("#connection");
  const title = document.querySelector("#status-title");
  const copy = document.querySelector("#status-copy");
  if (status.connected) {
    state.className = "pill connected";
    state.textContent = "Connected";
    title.textContent = "Local broker connected";
    copy.textContent = "Lenses is ready to handle calls from local clients.";
    connection.textContent = status.connectedPorts.map((port) => `127.0.0.1:${port}`).join(", ");
  } else {
    state.className = "pill disconnected";
    state.textContent = "Waiting";
    title.textContent = "Waiting for a local client";
    copy.textContent = "The bridge is enabled. It will connect automatically when a Lenses client starts the broker.";
    connection.textContent = "Not connected";
  }
}

chrome.runtime.sendMessage({ type: "action:get-status" }).then(render).catch(() => {
  state.className = "pill disconnected";
  state.textContent = "Unavailable";
});
setInterval(() => {
  void chrome.runtime.sendMessage({ type: "action:get-status" }).then((status) => {
    // Do not reset the acknowledgement checkbox while onboarding is in progress.
    if (status.consented) render(status);
  }).catch(() => {});
}, 1500);
