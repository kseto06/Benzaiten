import "./style.css";
import { initializeFirebaseAuth } from "./scripts/app/auth";
import { renderRoute } from "./scripts/app/router";

initializeFirebaseAuth();
window.addEventListener("hashchange", renderRoute);
renderRoute();
