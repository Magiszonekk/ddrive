import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import "./index.css";

// basename mirrors vite.config.ts `base`. The SPA is mounted at /app/* by
// nginx (ddrive.cikowice.pl/app/), and React Router needs to know so that
// <Link to="/drop"> resolves to /app/drop and not /drop.
const BASENAME = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "") || "/";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={BASENAME === "/" ? undefined : BASENAME}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
