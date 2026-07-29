import { startBridgeConnections } from "./background/bridge.js";
import { listenForIntercepts } from "./background/intercepts.js";
import { watchGateNotifications } from "./background/notifications.js";

listenForIntercepts();
watchGateNotifications();
startBridgeConnections();
