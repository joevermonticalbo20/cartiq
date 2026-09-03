import ErrorBoundary from "./ErrorBoundary.jsx";

const FALLBACK = (
  <div className="error-boundary" style={{ margin: 20 }}>
    <h3>Page failed to load</h3>
    <p>Something went wrong on this page. Other pages should still work.</p>
  </div>
);

export default function PageErrorBoundary({ children }) {
  return <ErrorBoundary fallbackComponent={FALLBACK}>{children}</ErrorBoundary>;
}
