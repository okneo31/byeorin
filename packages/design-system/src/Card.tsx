import * as React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 'default' = subtle shadow, 'flat' = no shadow, 'elevated' = larger shadow. */
  elevation?: 'flat' | 'default' | 'elevated';
  /** 시맨틱 태그 변경 (예: 'section', 'article'). */
  as?: 'div' | 'section' | 'article' | 'aside';
}

/**
 * Card — padding + radius + shadow 컨테이너.
 * 토큰 var(--nd-paper, --nd-radius-lg, --nd-shadow-*)를 사용한다.
 */
export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { elevation = 'default', as = 'div', className, children, ...rest },
  ref,
) {
  const Tag = as as React.ElementType;
  const classes = [
    'nd-card',
    elevation === 'flat' && 'nd-card--flat',
    elevation === 'elevated' && 'nd-card--elevated',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag ref={ref} className={classes} {...rest}>
      {children}
    </Tag>
  );
});

export default Card;
