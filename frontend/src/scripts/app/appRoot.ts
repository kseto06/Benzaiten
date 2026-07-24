const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("Benzaiten app root was not found.");
}

export const app = appRoot;
