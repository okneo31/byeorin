import * as React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 로딩 중일 때 스피너를 표시하고 클릭을 막는다. */
  loading?: boolean;
  /** 라벨 앞에 표시할 아이콘. */
  leadingIcon?: React.ReactNode;
  /** 라벨 뒤에 표시할 아이콘. */
  trailingIcon?: React.ReactNode;
  /** 한국어 라벨은 호출자가 prop으로 주입한다 (예: "송금하기"). */
  children: React.ReactNode;
}

/**
 * Button — 모든 한국어 라벨은 외부에서 주입한다.
 * 클래스는 tokens.css의 .nd-button* 규칙을 사용한다.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      leadingIcon,
      trailingIcon,
      disabled,
      className,
      type,
      children,
      ...rest
    },
    ref,
  ) {
    const isDisabled = disabled || loading;
    const classes = [
      'nd-button',
      `nd-button--${variant}`,
      `nd-button--${size}`,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={classes}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        aria-disabled={isDisabled || undefined}
        {...rest}
      >
        {loading ? (
          <span className="nd-button__spinner" aria-hidden="true" />
        ) : (
          leadingIcon && <span aria-hidden="true">{leadingIcon}</span>
        )}
        <span>{children}</span>
        {!loading && trailingIcon && <span aria-hidden="true">{trailingIcon}</span>}
      </button>
    );
  },
);

export default Button;
