import "@fontsource-variable/bricolage-grotesque";
import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { ApiError, setVaultLockedHandler } from "./api";
import App from "./App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A locked drive or a missing folder won't fix itself; only retry real outages.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      staleTime: 5_000,
    },
  },
});

// An idle timeout or a server restart locks the vault: send the app back to the login screen.
setVaultLockedHandler(() => void queryClient.invalidateQueries({ queryKey: ["vault"] }));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
