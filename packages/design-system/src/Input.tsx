import * as React from 'react';

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** 라벨 텍스트 (호출자가 한국어 문자열을 주입). */
  label?: React.ReactNode;
  /** 라벨 아래 보조 설명. */
  hint?: React.ReactNode;
  /** 에러 메시지가 있으면 input이 aria-invalid 상태가 되고 빨간 테두리. */
  error?: React.ReactNode;
  /** 주소·해시 등 등폭 글꼴이 자연스러운 입력에 사용. */
  mono?: boolean;
  /** input 요소에 직접 적용할 클래스. */
  inputClassName?: string;
}

/**
 * Input — 라벨 + 입력 + 에러 슬롯이 한 번에 묶인 폼 필드.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, mono, id, inputClassName, className, ...rest },
  ref,
) {
  const reactId = React.useId();
  const inputId = id ?? reactId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy =
    [hintId, errorId].filter(Boolean).join(' ') || undefined;

  const cls = [
    'nd-input',
    mono && 'nd-input--mono',
    inputClassName,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={['nd-field', className].filter(Boolean).join(' ')}>
      {label && (
        <label htmlFor={inputId} className="nd-field__label">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={cls}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && !error && (
        <div id={hintId} className="nd-field__hint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errorId} className="nd-field__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
});

export default Input;
