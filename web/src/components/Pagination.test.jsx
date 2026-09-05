import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Pagination from "./Pagination.jsx";

describe("Pagination", () => {
  it("renders nothing when no meta", () => {
    const { container } = render(<Pagination meta={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders total count but no buttons when only one page", () => {
    render(<Pagination meta={{ total: 5, page: 1, totalPages: 1 }} onPage={() => {}} />);
    expect(screen.getByText("5 record(s)")).toBeInTheDocument();
  });

  it("renders the count even for a single item", () => {
    render(<Pagination meta={{ total: 1, page: 1, totalPages: 1 }} onPage={() => {}} />);
    expect(screen.getByText("1 record(s)")).toBeInTheDocument();
  });

  it("renders page buttons when multiple pages", () => {
    const onPage = vi.fn();
    render(<Pagination meta={{ total: 50, page: 1, totalPages: 5 }} onPage={onPage} />);
    fireEvent.click(screen.getByLabelText("Next page"));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it("disables prev button on first page", () => {
    render(<Pagination meta={{ total: 50, page: 1, totalPages: 5 }} onPage={() => {}} />);
    expect(screen.getByLabelText("Previous page")).toBeDisabled();
  });

  it("disables next button on last page", () => {
    render(<Pagination meta={{ total: 50, page: 5, totalPages: 5 }} onPage={() => {}} />);
    expect(screen.getByLabelText("Next page")).toBeDisabled();
  });

  it("highlights current page", () => {
    render(<Pagination meta={{ total: 50, page: 2, totalPages: 5 }} onPage={() => {}} />);
    const currentBtn = screen.getByText("2");
    expect(currentBtn).toHaveClass("current");
  });

  it("marks the current page for assistive tech", () => {
    render(<Pagination meta={{ total: 50, page: 2, totalPages: 5 }} onPage={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Table pages" })).toBeInTheDocument();
    expect(screen.getByLabelText("Page 2")).toHaveAttribute("aria-current", "page");
  });
});
