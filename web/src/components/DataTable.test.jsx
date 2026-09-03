import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DataTable from "./DataTable.jsx";

const sample = [
  { id: 1, name: "Apple", price: 10, category: "fruit" },
  { id: 2, name: "Bread", price: 25, category: "bakery" },
  { id: 3, name: "Carrot", price: 5, category: "vegetable" },
];

const columns = [
  { key: "name", label: "Name", sortable: true },
  { key: "price", label: "Price", align: "right", render: (row) => `P${row.price}`, sortable: true },
  { key: "category", label: "Category" },
];

describe("DataTable", () => {
  it("renders all rows", () => {
    render(<DataTable columns={columns} data={sample} />);
    expect(screen.getByText("Apple")).toBeInTheDocument();
    expect(screen.getByText("Bread")).toBeInTheDocument();
    expect(screen.getByText("Carrot")).toBeInTheDocument();
  });

  it("renders column headers", () => {
    render(<DataTable columns={columns} data={sample} />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Price")).toBeInTheDocument();
    expect(screen.getByText("Category")).toBeInTheDocument();
  });

  it("uses render function when provided", () => {
    render(<DataTable columns={columns} data={sample} />);
    expect(screen.getByText("P10")).toBeInTheDocument();
    expect(screen.getByText("P25")).toBeInTheDocument();
  });

  it("shows empty message when data is empty", () => {
    render(<DataTable columns={columns} data={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("shows default empty message when no data prop", () => {
    render(<DataTable columns={columns} />);
    expect(screen.getByText("Nothing to display here")).toBeInTheDocument();
  });

  it("calls onRowClick with the row when clicked", () => {
    const handleClick = vi.fn();
    render(<DataTable columns={columns} data={sample} onRowClick={handleClick} />);
    fireEvent.click(screen.getByText("Apple"));
    expect(handleClick).toHaveBeenCalledWith(sample[0]);
  });

  it("does not call onRowClick when not provided", () => {
    render(<DataTable columns={columns} data={sample} />);
    expect(() => fireEvent.click(screen.getByText("Apple"))).not.toThrow();
  });

  it("applies width style to header when column has width", () => {
    const colsWithWidth = [{ key: "name", label: "Name", width: "50%" }];
    render(<DataTable columns={colsWithWidth} data={sample} />);
    const header = screen.getByText("Name").closest("th");
    expect(header).toHaveStyle({ width: "50%" });
  });

  it("shows 5 skeleton rows when loading", () => {
    render(<DataTable columns={columns} data={[]} loading={true} />);
    expect(screen.getAllByRole("row")).toHaveLength(6);
    expect(document.querySelectorAll(".skel")).toHaveLength(15);
  });

  it("does not show skeleton rows when not loading", () => {
    render(<DataTable columns={columns} data={sample} loading={false} />);
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(document.querySelectorAll(".skel")).toHaveLength(0);
  });

  it("calls onSort with key and asc when sortable header is clicked", () => {
    const handleSort = vi.fn();
    render(
      <DataTable columns={columns} data={sample} onSort={handleSort} />
    );
    fireEvent.click(screen.getByText("Name"));
    expect(handleSort).toHaveBeenCalledWith("name", "asc");
  });

  it("calls onSort with key and desc when same sortable header is clicked again", () => {
    const handleSort = vi.fn();
    render(
      <DataTable columns={columns} data={sample} onSort={handleSort} />
    );
    fireEvent.click(screen.getByText("Price"));
    fireEvent.click(screen.getByText("Price"));
    expect(handleSort).toHaveBeenLastCalledWith("price", "desc");
  });

  it("non-sortable columns do not call onSort", () => {
    const handleSort = vi.fn();
    render(
      <DataTable columns={columns} data={sample} onSort={handleSort} />
    );
    fireEvent.click(screen.getByText("Category"));
    expect(handleSort).not.toHaveBeenCalled();
  });

  it("renders empty state with default message when no data and no emptyMessage", () => {
    render(<DataTable columns={columns} />);
    expect(screen.getByText("Nothing to display here")).toBeInTheDocument();
  });

  it("renders empty state with custom message", () => {
    render(<DataTable columns={columns} data={[]} emptyMessage="No results found" />);
    expect(screen.getByText("No results found")).toBeInTheDocument();
  });
});
