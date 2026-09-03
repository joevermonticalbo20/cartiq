import { useEffect, useLayoutEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Boxes,
  FileSpreadsheet,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  ReceiptText,
  Settings as SettingsIcon,
  Sun,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import api from "../api.js";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/sales", label: "Sales", icon: ReceiptText },
  { to: "/inventory", label: "Inventory", icon: Boxes },
  { to: "/staff", label: "Staff & Shifts", icon: Users },
  { to: "/analytics", label: "Analytics", icon: TrendingUp },
  { to: "/expenses", label: "Expenses", icon: Wallet },
  { to: "/data", label: "Data Hub", icon: FileSpreadsheet },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("cartiq_sidebar_collapsed") === "1"
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === "dark"
  );

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    if (next) {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("cartiq_theme", "dark");
    } else {
      delete document.documentElement.dataset.theme;
      localStorage.setItem("cartiq_theme", "light");
    }
  }

  useEffect(() => {
    api.get("/auth/me").then(({ data }) => setUser(data.user)).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    setTimeout(() => setMobileOpen(false), 0);
  }, [location.pathname]);

  function toggleSidebar() {
    setCollapsed((c) => {
      localStorage.setItem("cartiq_sidebar_collapsed", c ? "0" : "1");
      return !c;
    });
  }

  function logout() {
    localStorage.removeItem("cartiq_token");
    navigate("/login");
  }

  const current = NAV.find((n) => location.pathname.startsWith(n.to));
  const initial = user?.name?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="shell">
      {mobileOpen && (
        <div className="backdrop show" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={`sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="side-logo">
          <div className="logo-mark">CQ</div>
          {!collapsed && (
            <div className="logo-text">
              <strong>CartIQ</strong>
              <span>Pota Fries Operations</span>
            </div>
          )}
        </div>

        <nav className="side-nav">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              title={label}
            >
              <Icon size={19} strokeWidth={2.2} />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="side-foot">
          <button className="ghost nav-item" onClick={toggleSidebar} title="Toggle sidebar">
            <Menu size={19} />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      <div className={`main-area ${collapsed ? "collapsed" : ""}`}>
        <header className="topbar">
          <div className="topbar-left">
            <button className="ghost icon-only hamburger" onClick={() => setMobileOpen(true)}>
              <Menu size={20} />
            </button>
            <span className="topbar-title">{current?.label ?? "CartIQ"}</span>
          </div>
          <div className="user-chip">
            <span>
              {user ? `${user.name}${user.location ? ` · ${user.location.code}` : ""}` : "..."}
            </span>
            <div className="avatar">{initial}</div>
            <button
              className="ghost icon-only"
              title={dark ? "Switch to light mode" : "Switch to dark mode"}
              onClick={toggleTheme}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="ghost icon-only" title="Log out" onClick={logout}>
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <main className="page-body" id="main-content">
          <Outlet context={{ user }} />
        </main>
      </div>
    </div>
  );
}
