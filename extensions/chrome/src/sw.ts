import { startBridgeConnections } from "./background/bridge.js";
import { listenForIntercepts } from "./background/intercepts.js";

listenForIntercepts();
startBridgeConnections();
