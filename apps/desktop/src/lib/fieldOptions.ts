// Choices for list fields, with the wording people see. Shared by the grid dropdowns and the
// edit panel so a value reads the same everywhere.

export interface Choice {
  value: string;
  label: string;
}

export const CHOICES: Record<string, Choice[]> = {
  status: [
    { value: "publish", label: "Published" },
    { value: "draft", label: "Draft" },
    { value: "pending", label: "Pending review" },
    { value: "private", label: "Private" },
  ],
  stock_status: [
    { value: "instock", label: "In stock" },
    { value: "outofstock", label: "Out of stock" },
    { value: "onbackorder", label: "On backorder" },
  ],
  catalog_visibility: [
    { value: "visible", label: "Shop and search" },
    { value: "catalog", label: "Shop only" },
    { value: "search", label: "Search only" },
    { value: "hidden", label: "Hidden" },
  ],
  type: [
    { value: "simple", label: "Simple" },
    { value: "variable", label: "Variable" },
    { value: "grouped", label: "Grouped" },
    { value: "external", label: "External / affiliate" },
  ],
  backorders: [
    { value: "no", label: "Do not allow" },
    { value: "notify", label: "Allow, notify customer" },
    { value: "yes", label: "Allow" },
  ],
  tax_status: [
    { value: "taxable", label: "Taxable" },
    { value: "shipping", label: "Shipping only" },
    { value: "none", label: "None" },
  ],
};

export const YES_NO: Choice[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

export function choiceLabel(field: string, value: unknown): string {
  const v = typeof value === "boolean" ? (value ? "yes" : "no") : String(value ?? "");
  return (CHOICES[field] ?? YES_NO).find((c) => c.value === v)?.label ?? v;
}
