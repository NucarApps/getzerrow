// Harness smoke test for the "ui" vitest project (jsdom + testing-library).
// A Radix dropdown is the canary: it exercises portals, pointer-capture,
// and the jsdom polyfills in src/test-setup.dom.ts. If this file passes,
// the component-test harness is sound for the rest of src/components.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

describe("ui harness smoke (Radix dropdown + button)", () => {
  it("renders a button whose variant reaches its class list", () => {
    // Compared against the default variant rather than matched against a
    // literal Tailwind token: the point is that the prop is wired through,
    // and pinning "bg-destructive" would fail on a rename that changed
    // nothing about the behaviour.
    const { unmount } = render(<Button>Delete</Button>);
    const base = screen.getByRole("button", { name: "Delete" }).className;
    unmount();

    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn).toBeInTheDocument();
    expect(btn.className).not.toBe(base);
  });

  it("opens the dropdown on click and fires the item's handler", async () => {
    const user = userEvent.setup();
    let picked = "";
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Open menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => (picked = "archive")}>Archive</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => (picked = "delete")}>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    // Content renders in a portal — the menu and items must still be found.
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(picked).toBe("archive");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
