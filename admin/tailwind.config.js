/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      // Colors are defined via CSS variables in App.css @theme block.
      // These aliases exist only for backward-compat with inline Tailwind classes
      // used in pages that reference dark.bg / dark.card / brand.* tokens.
      colors: {
        dark: {
          bg:     '#0a0a0a',
          card:   '#111111',
          border: '#1f1f1f',
        },
        brand: {
          50:  '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3',
          300: '#fda4af', 400: '#fb7185', 500: '#f43f5e',
          600: '#e11d48', 700: '#be123c', 800: '#9f1239',
          900: '#881337', 950: '#4c0519',
        },
      },
      borderRadius: {
        DEFAULT: '8px',
      },
    },
  },
  plugins: [],
};
