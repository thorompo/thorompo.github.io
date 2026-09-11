// ---------- Constants ----------
const TRANSLATE_API = 'https://translate.googleapis.com/translate_a/single';
const SOURCE_LANG = 'auto';
const WORD_REGEX = /[\p{L}]+/gu;
const WORD_TEST_REGEX = /\p{L}/u;
const WORD_SPLIT_REGEX = /([\p{L}]+)/gu;
const MIN_MINUTES = 0.0001;
const CHARS_PER_WORD = 5;

// Whitelist: any letter (any script), any number, combining marks,
// whitespace, common punctuation and basic math symbols.
// Everything else (emoji, control chars, exotic symbols) is stripped.
const SANITIZE_REGEX = /[^\p{L}\p{N}\p{M}\s.,;:!?'"„“”‚‘’()\[\]\-–—…+*\/=%<>^]/gu;

function sanitizeInput(text) {
  return text.replace(SANITIZE_REGEX, '');
}

// ---------- DOM references ----------
const setupDiv = document.getElementById('setupDiv');
const typingArea = document.getElementById('typingArea');
const statsDisplay = document.getElementById('statsDisplay');
const customTextInput = document.getElementById('customTextInput');
const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const loadingMsg = document.getElementById('loadingMsg');
const wpmResultEl = document.getElementById('wpmResult');
const accResultEl = document.getElementById('accResult');
const comboResultEl = document.getElementById('comboResult');
const hiddenInput = document.getElementById('hiddenInput');

// ---------- State ----------
const state = {
  characters: [],
  lineStats: [],
  groups: [],
  currentIndex: 0,
  totalMistakes: 0,
  startTime: null,
  lastKeyTime: null,
  isTestActive: false,
};

// ---------- Translation API ----------
async function translateText(text, targetLang) {
  if (!text) return '';
  const url = `${TRANSLATE_API}?client=gtx&sl=${SOURCE_LANG}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data[0].map(item => item[0]).join('');
  } catch (error) {
    console.error('Translation error:', error);
    return 'Error';
  }
}

function parseLines(rawText) {
  return rawText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

function extractUniqueWords(text) {
  const matches = text.match(WORD_REGEX) || [];
  return [...new Set(matches.map(w => w.toLowerCase()))];
}

async function translateWords(words, targetLang) {
  return Promise.all(words.map(word => translateText(word, targetLang)));
}

async function fetchTranslations(cleanText, uniqueWords) {
  const [huText, enText, wordsHu, wordsEn] = await Promise.all([
    translateText(cleanText, 'hu'),
    translateText(cleanText, 'en'),
    translateWords(uniqueWords, 'hu'),
    translateWords(uniqueWords, 'en'),
  ]);
  return {
    huLines: huText.split('\n'),
    enLines: enText.split('\n'),
    wordsHu,
    wordsEn,
  };
}

function buildWordDictionary(uniqueWords, wordsHu, wordsEn) {
  const dict = {};
  uniqueWords.forEach((word, i) => {
    dict[word] = {
      hu: (wordsHu[i] || word).trim(),
      en: (wordsEn[i] || word).trim(),
    };
  });
  return dict;
}

// ---------- DOM builders ----------
function createCharSpan(char, lineIndex) {
  const span = document.createElement('span');
  span.innerText = char;
  span.classList.add('char');
  span.dataset.line = lineIndex;
  return span;
}

function createWordSpan(token, lineIndex, wordDict) {
  const wordSpan = document.createElement('span');
  wordSpan.classList.add('word');

  const subscript = document.createElement('span');
  subscript.classList.add('word-subscript');
  const trans = wordDict[token.toLowerCase()] || { hu: token, en: token };
  subscript.innerHTML =
    `(<span class="sub-hu">${trans.hu}</span>, <span class="sub-en">${trans.en}</span>)`;
  wordSpan.appendChild(subscript);

  const charSpans = [];
  for (const char of token) {
    const charSpan = createCharSpan(char, lineIndex);
    wordSpan.appendChild(charSpan);
    charSpans.push(charSpan);
  }
  return { wordSpan, charSpans };
}

function createTypingLine(targetText, lineIndex, wordDict, isLastLine) {
  const typingDiv = document.createElement('div');
  typingDiv.classList.add('typing-line');

  const textToType = isLastLine ? targetText : targetText + ' ';
  const tokens = textToType.split(WORD_SPLIT_REGEX);
  const charSpans = [];

  for (const token of tokens) {
    if (!token) continue;

    if (WORD_TEST_REGEX.test(token)) {
      const { wordSpan, charSpans: wordChars } = createWordSpan(token, lineIndex, wordDict);
      typingDiv.appendChild(wordSpan);
      charSpans.push(...wordChars);
    } else {
      for (const char of token) {
        const charSpan = createCharSpan(char, lineIndex);
        typingDiv.appendChild(charSpan);
        charSpans.push(charSpan);
      }
    }
  }
  return { typingDiv, charSpans };
}

function createTranslationContainer(huText, enText) {
  const container = document.createElement('div');
  container.classList.add('trans-container');

  const huDiv = document.createElement('div');
  huDiv.classList.add('trans-hu');
  huDiv.innerText = (huText || 'Translation not available').trim();
  container.appendChild(huDiv);

  const enDiv = document.createElement('div');
  enDiv.classList.add('trans-en');
  enDiv.innerText = (enText || 'Translation not available').trim();
  container.appendChild(enDiv);

  const statsEl = document.createElement('div');
  statsEl.classList.add('line-stats');
  container.appendChild(statsEl);

  return { container, statsEl };
}

function buildLineGroup(targetText, lineIndex, wordDict, huText, enText, isLastLine) {
  const groupDiv = document.createElement('div');
  groupDiv.classList.add('line-group');

  const { typingDiv, charSpans } = createTypingLine(targetText, lineIndex, wordDict, isLastLine);
  groupDiv.appendChild(typingDiv);

  const { container: transContainer, statsEl } = createTranslationContainer(huText, enText);
  groupDiv.appendChild(transContainer);

  return { groupDiv, charSpans, transContainer, statsEl };
}

function renderTypingArea(originalLines, wordDict, huLines, enLines) {
  typingArea.innerHTML = '';
  state.characters = [];
  state.lineStats = [];
  state.groups = [];

  originalLines.forEach((targetText, index) => {
    const startIndex = state.characters.length;
    const isLastLine = index === originalLines.length - 1;

    const { groupDiv, charSpans, transContainer, statsEl } =
      buildLineGroup(targetText, index, wordDict, huLines[index], enLines[index], isLastLine);

    state.characters.push(...charSpans);
    typingArea.appendChild(groupDiv);

    const endIndex = state.characters.length - 1;
    state.lineStats.push({
      startIndex,
      endIndex,
      charCount: endIndex - startIndex + 1,
      startTime: null,
      endTime: null,
      mistakes: 0,
      finalized: false,
      statsEl,
      transContainer,
    });
    state.groups.push(groupDiv);
  });
}

// ---------- Test lifecycle ----------
function resetState() {
  state.currentIndex = 0;
  state.totalMistakes = 0;
  state.startTime = null;
  state.lastKeyTime = null;
  state.isTestActive = true;
}

function startTest() {
  resetState();
  if (window.PowerMode) window.PowerMode.resetStats();
  typingArea.classList.remove('hidden');
  typingArea.style.paddingBottom = '50vh';

  if (state.characters.length > 0) {
    state.characters[0].classList.add('active');
    highlightActiveGroup();
  }
  window.scrollTo(0, 0);
  focusInput();
}

async function handleStart() {
  const rawText = sanitizeInput(customTextInput.value).trim();
  if (!rawText) return;

  // Focus the hidden input synchronously while we're still inside the
  // user gesture — required for iOS to open the virtual keyboard later.
  focusInput();

  startBtn.disabled = true;
  loadingMsg.classList.remove('hidden');

  try {
    const originalLines = parseLines(rawText);
    const cleanText = originalLines.join('\n');
    const uniqueWords = extractUniqueWords(cleanText);

    const { huLines, enLines, wordsHu, wordsEn } =
      await fetchTranslations(cleanText, uniqueWords);
    const wordDict = buildWordDictionary(uniqueWords, wordsHu, wordsEn);

    setupDiv.classList.add('hidden');
    statsDisplay.classList.add('hidden');

    renderTypingArea(originalLines, wordDict, huLines, enLines);
    startTest();
  } finally {
    loadingMsg.classList.add('hidden');
    startBtn.disabled = false;
  }
}

// ---------- UI updates ----------
function highlightActiveGroup() {
  for (const group of document.querySelectorAll('.line-group')) {
    group.classList.remove('active-group');
  }
  const current = state.characters[state.currentIndex];
  if (!current) return;

  const activeGroup = current.closest('.line-group');
  if (activeGroup) {
    activeGroup.classList.add('active-group');
    activeGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function updateWordStatus(charElement) {
  if (!charElement) return;
  const wordSpan = charElement.closest('.word');
  if (!wordSpan) return;

  const chars = Array.from(wordSpan.querySelectorAll('.char'));
  const isDone = chars.every(c =>
    c.classList.contains('correct') || c.classList.contains('incorrect'));
  wordSpan.classList.toggle('completed', isDone);
}

function lineOf(index) {
  if (index < 0 || index >= state.characters.length) return -1;
  return parseInt(state.characters[index].dataset.line, 10);
}

// ---------- Stats ----------
function computeWpmAndAccuracy(charCount, mistakes, startTime, endTime) {
  const minutes = Math.max((endTime - startTime) / 60000, MIN_MINUTES);
  const correct = Math.max(charCount - mistakes, 0);
  const wpm = Math.max(Math.round((correct / CHARS_PER_WORD) / minutes), 0);
  const accuracy = charCount > 0
    ? Math.max(Math.round((correct / charCount) * 100), 0)
    : 0;
  return { wpm, accuracy };
}

function finalizeLine(lineIndex) {
  const ls = state.lineStats[lineIndex];
  if (!ls || ls.finalized) return;
  ls.finalized = true;

  if (!ls.endTime) ls.endTime = state.lastKeyTime || new Date();
  if (!ls.startTime) ls.startTime = ls.endTime;

  const { wpm, accuracy } =
    computeWpmAndAccuracy(ls.charCount, ls.mistakes, ls.startTime, ls.endTime);

  ls.statsEl.innerHTML =
    `<span class="stat-label">Line stats:</span> ${wpm} WPM · ${accuracy}% accuracy`;
  ls.transContainer.classList.add('revealed');
}

function endTest() {
  state.isTestActive = false;
  const endTime = state.lastKeyTime || new Date();
  const { wpm, accuracy } = computeWpmAndAccuracy(
    state.characters.length,
    state.totalMistakes,
    state.startTime,
    endTime,
  );

  wpmResultEl.innerText = wpm;
  accResultEl.innerText = accuracy;
  if (comboResultEl) {
    comboResultEl.innerText = window.PowerMode ? window.PowerMode.getMaxCombo() : 0;
  }

  typingArea.style.paddingBottom = '2rem';
  statsDisplay.classList.remove('hidden');
  statsDisplay.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- Key handling ----------
function isIgnoredKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  return event.key.length !== 1 && event.key !== 'Backspace';
}

function handleBackspace() {
  if (state.currentIndex === 0) return;

  state.characters[state.currentIndex].classList.remove('active');
  state.currentIndex--;
  const prev = state.characters[state.currentIndex];
  prev.classList.remove('correct', 'incorrect');
  prev.classList.add('active');

  updateWordStatus(prev);
  highlightActiveGroup();
}

function recordKeystroke(typedChar, now) {
  if (!state.startTime) state.startTime = now;
  state.lastKeyTime = now;

  const lineIndex = lineOf(state.currentIndex);
  const ls = state.lineStats[lineIndex];
  if (ls && !ls.startTime) ls.startTime = now;

  const currentCharEl = state.characters[state.currentIndex];
  const expected = currentCharEl.textContent;

  currentCharEl.classList.remove('active');
  const isCorrect = typedChar === expected;
  if (isCorrect) {
    currentCharEl.classList.add('correct');
  } else {
    currentCharEl.classList.add('incorrect');
    state.totalMistakes++;
    if (ls) ls.mistakes++;
  }

  if (window.PowerMode) window.PowerMode.trigger(currentCharEl, isCorrect);

  updateWordStatus(currentCharEl);
  if (ls) ls.endTime = now;

  state.currentIndex++;
  return lineIndex;
}

function handleKeydown(event) {
  if (!state.isTestActive || isIgnoredKey(event)) return;
  event.preventDefault();

  if (event.key === 'Backspace') {
    handleBackspace();
    return;
  }

  const previousLine = recordKeystroke(event.key, new Date());

  if (state.currentIndex === state.characters.length) {
    finalizeLine(lineOf(state.characters.length - 1));
    endTest();
    return;
  }

  const nextLine = lineOf(state.currentIndex);
  if (nextLine !== previousLine) {
    finalizeLine(previousLine);
    highlightActiveGroup();
  }
  state.characters[state.currentIndex].classList.add('active');
}

function handleReset() {
  statsDisplay.classList.add('hidden');
  typingArea.classList.add('hidden');
  typingArea.innerHTML = '';
  setupDiv.classList.remove('hidden');
  if (window.PowerMode) window.PowerMode.resetStats();
  window.scrollTo(0, 0);
  hiddenInput.blur();
}

function focusInput() {
  hiddenInput.value = '';
  hiddenInput.focus();
}

function processTypedChar(char) {
  if (!state.isTestActive) return;

  const previousLine = recordKeystroke(char, new Date());

  if (state.currentIndex === state.characters.length) {
    finalizeLine(lineOf(state.characters.length - 1));
    endTest();
    return;
  }

  const nextLine = lineOf(state.currentIndex);
  if (nextLine !== previousLine) {
    finalizeLine(previousLine);
    highlightActiveGroup();
  }
  state.characters[state.currentIndex].classList.add('active');
}

function handleBeforeInput(event) {
  if (!state.isTestActive) return;

  if (event.inputType === 'deleteContentBackward') {
    event.preventDefault();
    handleBackspace();
    return;
  }

  const data = event.data;
  if (data == null) return;

  event.preventDefault();
  for (const char of data) {
    processTypedChar(char);
    if (!state.isTestActive) break;
  }
}

function handleInputFallback() {
  // Some mobile IMEs don't honour preventDefault in beforeinput.
  // Drain whatever ended up in the input and feed it through.
  const value = hiddenInput.value;
  if (!value) return;
  hiddenInput.value = '';
  for (const char of value) {
    processTypedChar(char);
    if (!state.isTestActive) break;
  }
}

// ---------- Wire up ----------
startBtn.addEventListener('click', handleStart);
typingArea.addEventListener('keydown', handleKeydown);
hiddenInput.addEventListener('keydown', handleKeydown);
hiddenInput.addEventListener('beforeinput', handleBeforeInput);
hiddenInput.addEventListener('input', handleInputFallback);

// Any tap anywhere on the page during an active test should re-focus the
// hidden input, so the mobile keyboard stays up. Must run from the user
// gesture, so use touchend/click (not blur).
function refocusFromGesture(event) {
  if (!state.isTestActive) return;
  // Don't steal focus from the reset button or other interactive controls.
  const target = event.target;
  if (target && target.closest && target.closest('button, a, input, textarea, select')) {
    if (target !== hiddenInput) return;
  }
  focusInput();
}
document.addEventListener('touchend', refocusFromGesture);
document.addEventListener('click', refocusFromGesture);

resetBtn.addEventListener('click', handleReset);
