import { useEffect } from "react";
import { useNavigate, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast.jsx";
import { setupAuthInterceptor } from "./api.js";
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
import SettingsPage from "./pages/SettingsPage.jsx";

function RequireAuth({ children }) {
  const token = localStorage.getItem("cartiq_token");
  return token ? children : <Navigate to="/login" replace />;
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
