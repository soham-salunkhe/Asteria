/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        michira: {
          bg: '#0B0D0D',
          bg2: '#151716',
          card: '#1B1D1C',
          elevated: '#232522',
          ink: '#F3EFE6',
          ink2: '#B4B2AA',
          ink3: '#777872',
          gold: '#B99550',
          gold2: '#D2A95D',
          olive: '#69725C',
          hair: 'rgba(243, 239, 230, 0.09)',
        },
        yatra: {
          50: '#f5f7ff',
          100: '#ebf0fe',
          200: '#cedaff',
          300: '#a3bbfd',
          400: '#7094fa',
          500: '#486ff5',
          600: '#2e4de8',
          700: '#2339ca',
          800: '#1e2fa3',
          900: '#1b2a80',
          950: '#11194e',
        },
        saffron: {
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
        },
        emerald: {
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        serif: ['Cormorant Garamond', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
}