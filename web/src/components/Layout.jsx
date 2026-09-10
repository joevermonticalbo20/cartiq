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
import ConfirmDialog from "./ConfirmDialog.jsx";

const NAV_GROUPS = [
  {
    label: "Menu",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/sales", label: "Sales", icon: ReceiptText },
      { to: "/inventory", label: "Inventory", icon: Boxes },
      { to: "/staff", label: "Staff & Shifts", icon: Users },
    ]
  },
  {
    label: "Financial",
    items: [
      { to: "/analytics", label: "Analytics", icon: TrendingUp },
      { to: "/expenses", label: "Expenses", icon: Wallet },
    ]
  },
  {
    label: "Tools",
    items: [
      { to: "/data", label: "Data Hub", icon: FileSpreadsheet },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ]
  }
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("cartiq_sidebar_collapsed") === "1"
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
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

  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  function toggleSidebar() {
    setCollapsed((c) => {
      localStorage.setItem("cartiq_sidebar_collapsed", c ? "0" : "1");
      return !c;
    });
  }

  // Validation: with no session token there is nothing to confirm.
  function requestLogout() {
    if (!localStorage.getItem("cartiq_token")) {
      navigate("/login");
      return;
    }
    setConfirmingLogout(true);
  }

  function logout() {
    localStorage.removeItem("cartiq_token");
    localStorage.removeItem("cartiq_refresh_token");
    setConfirmingLogout(false);
    navigate("/login");
  }

  const initial = user?.name?.[0]?.toUpperCase() ?? "?";
  
  // Drawer labels always show when open on mobile, even if desktop is collapsed.
  const showLabels = !collapsed || mobileOpen;

  return (
    <div className="shell">
      {mobileOpen && (
        <div className="backdrop show" onClick={() => setMobileOpen(false)} />
      )}
      
      <aside
        id="cartiq-sidebar"
        aria-label="Primary navigation"
        className={`sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}
      >
        <div className="side-logo">
          <img src="/logo.png" alt="CartIQ Logo" className="logo-icon" />
          {showLabels && (
            <div className="logo-text">
              <strong>CartIQ</strong>
              <span>Pota Fries Operations</span>
            </div>
          )}
        </div>
        
        <nav className="side-nav">
          {NAV_GROUPS.map((group, idx) => (
            <div key={idx} className="nav-group">
              {showLabels && <div className="nav-group-label">{group.label}</div>}
              {group.items.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
                  title={label}
                >
                  <Icon size={19} strokeWidth={2.2} />
                  {showLabels && <span>{label}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="side-foot">
          <button className="ghost nav-item" onClick={toggleSidebar} title="Toggle sidebar">
            <Menu size={19} />
            {showLabels && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      <div className={`main-area ${collapsed ? "collapsed" : ""}`}>
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="ghost icon-only hamburger"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileOpen}
              aria-controls="cartiq-sidebar"
            >
              <Menu size={20} />
            </button>
            {/* IBINALIK: Lalabas lang ang title kapag nasa Dashboard */}
            {location.pathname === "/dashboard" && (
              <span className="topbar-title">Dashboard</span>
            )}
          </div>
          
          <div className="user-chip">
            <button
              className="ghost icon-only theme-toggle"
              title={dark ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              aria-pressed={dark}
              onClick={toggleTheme}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="ghost icon-only logout-btn"
              title="Log out"
              aria-label="Log out"
              onClick={requestLogout}
            >
              <LogOut size={18} />
            </button>
            
            <div className="user-profile-wrapper">
              <div className="user-chip-info">
                <span className="user-chip-name">{user ? user.name : "Loading..."}</span>
                <span className="user-chip-role">
                  {user ? (user.location ? user.location.name : "Administrator") : "..."}
                </span>
              </div>
              <div className="avatar">{initial}</div>
            </div>
          </div>
        </header>
        
        <main className="page-body" id="main-content">
          <Outlet context={{ user }} />
        </main>
      </div>

      <ConfirmDialog
        open={confirmingLogout}
        title={user ? `Log out ${user.name}?` : "Log out?"}
        message="You'll be signed out on this device."
        confirmLabel="Log out"
        onConfirm={logout}
        onCancel={() => setConfirmingLogout(false)}
      />
    </div>
  );
}