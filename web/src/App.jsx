import { lazy, Suspense, useEffect } from "react";
import { useNavigate, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast.jsx";
import { setupAuthInterceptor, isTokenExpired, readSessionToken, readRefreshToken } from "./api.js";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";

// Route-split authenticated pages so the login screen's initial bundle stays
// small. Each page is still loaded from the same production build.
const DashboardPage = lazy(() => import("./pages/DashboardPage.jsx"));
const SalesPage = lazy(() => import("./pages/SalesPage.jsx"));
const VoidRequestsPage = lazy(() => import("./pages/VoidRequestsPage.jsx"));
const InventoryPage = lazy(() => import("./pages/InventoryPage.jsx"));
const StaffPage = lazy(() => import("./pages/StaffPage.jsx"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage.jsx"));
const ExpensesPage = lazy(() => import("./pages/ExpensesPage.jsx"));
const DataPage = lazy(() => import("./pages/DataPage.jsx"));
const ProductsPage = lazy(() => import("./pages/ProductsPage.jsx"));
const SettingsPage = lazy(() => import("./pages/SettingsPage.jsx"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage.jsx"));

function PageFallback() {
  return (
    <div className="page-container wide">
      <div className="panel" style={{ padding: "var(--space-5)" }}>
        <p className="muted small" role="status">Loading page…</p>
      </div>
    </div>
  );
}

function RequireAuth({ children }) {
  const token = readSessionToken();
  const refresh = readRefreshToken();

  if (!token && !refresh) return <Navigate to="/login" replace />;
  if (token && isTokenExpired(token) && !refresh) {
    localStorage.removeItem("cartiq_token");
    return <Navigate to="/login" replace />;
  }
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const navigate = useNavigate();

  useEffect(() => {
    setupAuthInterceptor(navigate);
  }, [navigate]);

  return (
    <ErrorBoundary fallbackComponent={<div className="error-boundary"><h3>System Error</h3><p>Please refresh the page or contact support.</p></div>}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <ToastProvider>
        <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/sales" element={<SalesPage />} />
            <Route path="/sales/void-requests" element={<VoidRequestsPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/data" element={<DataPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
          </Route>

          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route
            path="*"
            element={
              <Navigate
                to={readSessionToken() ? "/dashboard" : "/login"}
                replace
              />
            }
          />
        </Routes>
        </Suspense>
      </ToastProvider>
    </ErrorBoundary>
  );
}