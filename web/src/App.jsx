import { useEffect } from "react";
import { useNavigate, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast.jsx";
import { setupAuthInterceptor, isTokenExpired, readSessionToken, readRefreshToken } from "./api.js";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import SalesPage from "./pages/SalesPage.jsx";
import InventoryPage from "./pages/InventoryPage.jsx";
import StaffPage from "./pages/StaffPage.jsx";
import AnalyticsPage from "./pages/AnalyticsPage.jsx";
import ExpensesPage from "./pages/ExpensesPage.jsx";
import DataPage from "./pages/DataPage.jsx";
import ProductsPage from "./pages/ProductsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import NotificationsPage from "./pages/NotificationsPage.jsx"; 

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
      </ToastProvider>
    </ErrorBoundary>
  );
}