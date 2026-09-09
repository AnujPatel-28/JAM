import React from 'react';

export const YouTubeIcon: React.FC<{ size?: number; color?: string; className?: string }> = ({
  size = 20,
  color = '#ff0000',
  className = '',
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ verticalAlign: 'middle', flexShrink: 0 }}
    >
      <path
        d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.5 12 3.5 12 3.5s-7.505 0-9.377.55a3.016 3.016 0 0 0-2.122 2.136C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.55 9.376.55 9.376.55s7.505 0 9.377-.55a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"
        fill={color}
      />
      <path d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z" fill="#ffffff" />
    </svg>
  );
};
