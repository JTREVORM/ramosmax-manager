import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field, Input } from './field';

/**
 * Regression: Field used to attach the id by cloning its child. When a control
 * was wrapped — as the password field is, for its reveal button — the id
 * landed on the wrapper and the real input was left unlabelled. The ids now
 * travel through context, so wrapping is safe.
 */
describe('Field', () => {
  it('labels a plain input', () => {
    render(
      <Field label="Phone number" htmlFor="phone">
        <Input name="phone" />
      </Field>,
    );
    expect(screen.getByLabelText('Phone number')).toHaveAttribute('name', 'phone');
  });

  it('labels an input that is WRAPPED in another element', () => {
    render(
      <Field label="Password" htmlFor="password">
        <div className="relative">
          <Input name="password" type="password" />
          <button type="button">Show</button>
        </div>
      </Field>,
    );
    const input = screen.getByLabelText('Password');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('name', 'password');
  });

  it('associates a hint with the control', () => {
    render(
      <Field label="Phone number" htmlFor="phone" hint="The registered number.">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText('Phone number')).toHaveAccessibleDescription(
      'The registered number.',
    );
  });

  it('announces an error and marks the control invalid', () => {
    render(
      <Field label="Phone number" htmlFor="phone" error="Enter a valid phone number.">
        <Input />
      </Field>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid phone number.');
    expect(screen.getByLabelText('Phone number')).toHaveAttribute('aria-invalid', 'true');
  });

  it('prefers the error over the hint as the description', () => {
    render(
      <Field label="Phone number" htmlFor="phone" hint="A hint." error="An error.">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText('Phone number')).toHaveAccessibleDescription('An error.');
  });
});
