import { useState, useRef, useEffect, useId } from "react";
import { ChevronDown } from "lucide-react";

export default function Select({ value, onChange, options = [], placeholder = "Select...", className = "" }) {
  const safeOptions = Array.isArray(options) ? options : [];
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const listId = useId();

  // Isara ang dropdown kapag nag-click sa labas
  useEffect(() => {
    function handleClickOutside(event) {
      if (ref.current && !ref.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedOption = safeOptions.find((o) => o.value === value);

  // Highlight follows the selected row whenever the menu opens.
  function openMenu() {
    setHighlighted(safeOptions.findIndex((o) => o.value === value));
    setOpen(true);
  }

  function choose(index) {
    const opt = safeOptions[index];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onTriggerKeyDown(e) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (safeOptions.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % safeOptions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + safeOptions.length) % safeOptions.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlighted(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlighted(safeOptions.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(highlighted);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const activeDescendant =
    highlighted >= 0 ? `${listId}-opt-${highlighted}` : undefined;

  return (
    <div className={`custom-select-wrapper ${className}`} ref={ref}>
      <button
        type="button"
        ref={buttonRef}
        className={`custom-select-trigger ${open ? "active" : ""}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? activeDescendant : undefined}
      >
        <span className="custom-select-value">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown size={16} className={`custom-select-icon ${open ? "open" : ""}`} />
      </button>

      {open && (
        <ul
          id={listId}
          className="custom-select-dropdown"
          role="listbox"
        >
          {safeOptions.length === 0 ? (
            <li className="custom-select-option empty" role="option" aria-selected="false" aria-disabled="true">
              No options available
            </li>
          ) : (
            safeOptions.map((opt, i) => {
              const isSelected = value === opt.value;
              return (
                <li
                  key={opt.value}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`custom-select-option${isSelected ? " selected" : ""}${i === highlighted ? " highlighted" : ""}`}
                  onClick={() => choose(i)}
                  onMouseEnter={() => setHighlighted(i)}
                >
                  {opt.label}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
