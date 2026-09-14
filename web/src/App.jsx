import { useEffect } from "react";
import { useNavigate, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast.jsx";
import { setupAuthInterceptor, isTokenExpired } from "./api.js";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import SalesPage from "./pages/SalesPage.jsx";
import InventoryPage from "./pages/InventoryPage.jsx";
import StaffPage from "./pages/StaffPage.jsx";
import AnalyticsPage from "./pages/AnalyticsPage.jsx";
import ExpensesPage from "./pages/ExpensesPage.jsx";
import DataPage from "./pages/DataPage.jsx";
import ProductsPage from "./pages/ProductsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

function RequireAuth({ children }) {
  const token = localStorage.getItem("cartiq_token");
  const refresh = localStorage.getItem("cartiq_refresh_token");
  // Expired access alone is not a logout: the interceptor will silently
  // refresh on the first 401. Only redirect when there is no session at all
  // (no access AND no refresh), or access is expired AND no refresh to recover.
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
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/data" element={<DataPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route
            path="*"
            element={
              <Navigate
                to={localStorage.getItem("cartiq_token") ? "/dashboard" : "/login"}
                replace
              />
            }
          />
        </Routes>
      </ToastProvider>
    </ErrorBoundary>
  );
}
