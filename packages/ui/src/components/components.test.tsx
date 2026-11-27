// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Button } from './button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './dropdown-menu.js';
import { EmptyState } from './empty-state.js';
import { Alert } from './alert.js';
import { Input } from './input.js';
import { Label } from './label.js';
import { PasswordInput } from './password-input.js';
import { Skeleton } from './skeleton.js';
import { Toaster, dismissToast, toast } from './toast.js';
import { UiProvider } from './ui-provider.js';

beforeAll(() => {
  // jsdom lacks the layout APIs Radix's positioning measures with.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('style').forEach((style) => style.remove());
});

const NONCE = 'dGVzdC1ub25jZS0xMjM0NQ==';

describe('Button', () => {
  it('is a non-submitting button by default, with the primary variant', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveProperty('type', 'button');
    expect(button.dataset.variant).toBe('primary');
    expect(button.className).toContain('bg-accent');
    expect(button.className).toContain('text-accent-foreground');
  });

  it('renders each variant from tokens only and can be disabled', () => {
    render(
      <>
        <Button variant="danger">Delete</Button>
        <Button variant="outline" disabled>
          Later
        </Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-danger');
    const later = screen.getByRole('button', { name: 'Later' });
    expect(later).toHaveProperty('disabled', true);
    expect(later.className).toContain('border-border-strong');
  });

  it('styles a link with asChild', () => {
    render(
      <Button asChild variant="link">
        <a href="/fa">فارسی</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'فارسی' });
    expect(link.getAttribute('href')).toBe('/fa');
    expect(link.getAttribute('type')).toBeNull();
    expect(link.dataset.slot).toBe('button');
  });
});

describe('Input and Skeleton', () => {
  it('marks invalid input for styling and assistive technology', () => {
    render(<Input aria-label="Habit name" aria-invalid dir="auto" defaultValue="مطالعه" />);
    const input = screen.getByRole('textbox', { name: 'Habit name' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.className).toContain('aria-invalid:border-danger');
    expect(input.getAttribute('dir')).toBe('auto');
  });

  it('hides the skeleton from assistive technology', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('EmptyState', () => {
  it('is a region named by its heading, with a decorative icon and an action', () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="هنوز عادتی ندارید"
        description="Habits you create will appear here."
        action={<Button>Create</Button>}
      />,
    );
    const region = screen.getByRole('region', { name: 'هنوز عادتی ندارید' });
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe('هنوز عادتی ندارید');
    expect(within(region).getByText('Habits you create will appear here.')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(screen.getByTestId('icon').parentElement?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the page outline with a configurable heading level and renders only what it gets', () => {
    render(<EmptyState title="Nothing yet" headingLevel={3} />);
    const region = screen.getByRole('region', { name: 'Nothing yet' });
    expect(within(region).getByRole('heading', { level: 3 })).toBeTruthy();
    expect(region.querySelector('p')).toBeNull();
    expect(region.querySelector('[aria-hidden]')).toBeNull();
  });
});

describe('Dialog', () => {
  function Example({ dir }: { dir: 'ltr' | 'rtl' }) {
    return (
      <UiProvider dir={dir} nonce={NONCE}>
        <Dialog>
          <DialogTrigger asChild>
            <Button>Open</Button>
          </DialogTrigger>
          <DialogContent closeLabel={dir === 'rtl' ? 'بستن' : 'Close'}>
            <DialogHeader>
              <DialogTitle>{dir === 'rtl' ? 'عادت جدید' : 'New habit'}</DialogTitle>
              <DialogDescription>Details</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </UiProvider>
    );
  }

  it('opens a labelled modal dialog with a localized close button; Escape closes it', async () => {
    const user = userEvent.setup();
    render(<Example dir="rtl" />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'عادت جدید' });
    expect(within(dialog).getByRole('button', { name: 'بستن' })).toBeTruthy();
    // Logical placement only: mirrors in RTL.
    expect(within(dialog).getByRole('button', { name: 'بستن' }).className).toContain('end-3');
    expect(dialog.className).not.toMatch(/\b(left|right)-/);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives the scroll-lock <style> it injects the CSP nonce', async () => {
    const user = userEvent.setup();
    render(<Example dir="ltr" />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const styles = [...document.head.querySelectorAll('style')];
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(style.getAttribute('nonce')).toBe(NONCE);
  });
});

describe('DropdownMenu', () => {
  function ThemeMenu({ dir, onChange }: { dir: 'ltr' | 'rtl'; onChange: (v: string) => void }) {
    return (
      <UiProvider dir={dir}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Theme</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value="dark" onValueChange={onChange}>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </UiProvider>
    );
  }

  it.each(['ltr', 'rtl'] as const)(
    'opens in %s with the direction and checked state',
    async (dir) => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ThemeMenu dir={dir} onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: 'Theme' }));
      const menu = screen.getByRole('menu');
      expect(menu.getAttribute('dir')).toBe(dir);
      const dark = screen.getByRole('menuitemradio', { name: 'Dark' });
      expect(dark.getAttribute('aria-checked')).toBe('true');
      expect(dark.className).toContain('ps-8');
      await user.click(screen.getByRole('menuitemradio', { name: 'Light' }));
      expect(onChange).toHaveBeenCalledWith('light');
      expect(screen.queryByRole('menu')).toBeNull();
    },
  );

  it('is keyboard operable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ThemeMenu dir="ltr" onChange={onChange} />);
    screen.getByRole('button', { name: 'Theme' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeTruthy();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('light');
  });
});

describe('Toaster', () => {
  it('shows toasts in a labelled region with localized close buttons', async () => {
    render(
      <UiProvider dir="rtl">
        <Toaster label="اعلان" regionLabel="اعلان‌ها" closeLabel="بستن" />
      </UiProvider>,
    );
    let id = 0;
    act(() => {
      id = toast({ title: 'ذخیره شد', description: 'عادت به‌روز شد.', variant: 'success' });
    });
    const region = screen.getByRole('region', { name: /اعلان‌ها/ });
    const item = within(region).getByText('ذخیره شد').closest('[data-slot="toast"]');
    expect(item?.getAttribute('data-variant')).toBe('success');
    expect(within(region).getByRole('button', { name: 'بستن' })).toBeTruthy();
    act(() => dismissToast(id));
    expect(screen.queryByText('ذخیره شد')).toBeNull();
  });

  it('keeps at most three toasts', () => {
    render(
      <UiProvider dir="ltr">
        <Toaster label="Notification" regionLabel="Notifications" closeLabel="Close" />
      </UiProvider>,
    );
    act(() => {
      for (const n of [1, 2, 3, 4]) toast({ title: `Toast ${n}` });
    });
    expect(screen.queryByText('Toast 1')).toBeNull();
    expect(screen.getByText('Toast 4')).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="toast"]').length).toBe(3);
  });
});

describe('form primitives (P2-09)', () => {
  it('Label names its control', () => {
    render(
      <>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" />
      </>,
    );
    expect(screen.getByLabelText('Email')).toHaveProperty('id', 'email');
  });

  it('PasswordInput toggles visibility with a pressed-state button and keeps value and focus', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Label htmlFor="pw">Password</Label>
        <PasswordInput id="pw" autoComplete="current-password" toggleLabel="Show password" />
      </>,
    );
    const field = screen.getByLabelText('Password') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
    expect(field.getAttribute('dir')).toBe('ltr');
    // The wrapper is LTR too, so the toggle and the reserved padding are on the same side in RTL.
    expect(field.closest('[data-slot="password-input"]')?.getAttribute('dir')).toBe('ltr');
    await user.type(field, 's3cret');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('pw');
    expect(toggle.getAttribute('type')).toBe('button');
    await user.click(toggle);
    expect(field.type).toBe('text');
    expect(field.value).toBe('s3cret');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    expect(field.type).toBe('password');
  });

  it('Alert uses role=alert for errors and role=status otherwise', () => {
    render(
      <>
        <Alert tone="danger">Wrong</Alert>
        <Alert tone="success">Done</Alert>
      </>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Wrong');
    expect(screen.getByRole('status').textContent).toBe('Done');
  });
});
