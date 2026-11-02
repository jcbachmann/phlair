// The table button of the toolbar asks for the size of the new table: a grid
// to pick columns and rows from, like in word processors.

import type { EditorView } from "@codemirror/view";
import { closeDropdown, showDropdownContent } from "../../dropdown";
import { insertTable } from "./commands";

const COLUMNS = 8;
const ROWS = 8;

/** Shows the size grid below a toolbar button. */
export function showTablePicker(view: EditorView, button: HTMLElement): void {
  const content = document.createElement("div");
  content.className = "rme-table-picker";
  const label = document.createElement("div");
  label.className = "rme-table-picker-label";
  const grid = document.createElement("div");
  grid.className = "rme-table-picker-grid";
  grid.setAttribute("role", "grid");
  const cells: HTMLElement[] = [];
  const mark = (columns: number, rows: number) => {
    cells.forEach((cell) => {
      const { col, row } = cell.dataset;
      cell.classList.toggle("rme-picked", Number(col) < columns && Number(row) <= rows);
    });
    label.textContent = `${columns} × ${rows} (columns × rows, plus a header row)`;
  };
  // Row 0 is the header row.
  for (let row = 0; row <= ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const cell = document.createElement("a");
      cell.href = "#";
      cell.className = row === 0 ? "rme-table-picker-cell rme-header" : "rme-table-picker-cell";
      cell.dataset.col = String(col);
      cell.dataset.row = String(row);
      cell.setAttribute("aria-label", `${col + 1} columns, ${Math.max(1, row)} rows`);
      cell.addEventListener("mouseenter", () => mark(col + 1, Math.max(1, row)));
      cell.addEventListener("click", (event) => {
        event.preventDefault();
        closeDropdown();
        view.focus();
        insertTable(view, col + 1, Math.max(1, row));
      });
      cells.push(cell);
      grid.append(cell);
    }
  }
  content.append(grid, label);
  mark(3, 2);
  const rect = button.getBoundingClientRect();
  showDropdownContent(rect.left, rect.bottom + 2, content, "rme-table-picker-menu");
}
