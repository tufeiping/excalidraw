// ext functions for FlyLaTeX

const setDefaultLanguage = (lang: string) => {
  localStorage.setItem("i18nextLng", lang);
};

const setDefaultLanguageWithDelay = (lang: string, delay: number = 1000) => {
  setTimeout(() => {
    setDefaultLanguage(lang);
  }, delay);
};

export { setDefaultLanguage, setDefaultLanguageWithDelay };
