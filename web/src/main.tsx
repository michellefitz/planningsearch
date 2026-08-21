import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import App from "./App";
import "./styles.css";

const QaPage = lazy(() => import("./components/QaPage"));

const isQa = window.location.pathname.startsWith("/qa");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isQa ? (
      <Suspense fallback={null}>
        <QaPage />
      </Suspense>
    ) : (
      <App />
    )}
    <Analytics />
  </React.StrictMode>
);
