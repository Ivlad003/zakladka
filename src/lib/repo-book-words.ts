// The words the app itself puts into a book made from a repository — headings of the pages it
// composes, labels of the facts — in each language such a book can be written in. The chapters are
// written by the model in that language; these few lines have to match them.

export interface BookLang {
  id: string;
  /** As the language calls itself: shown in the list. */
  name: string;
  /** As a model is told about it. */
  english: string;
}

export const BOOK_LANGS: BookLang[] = [
  { id: 'uk', name: 'Українська', english: 'Ukrainian' },
  { id: 'en', name: 'English', english: 'English' },
  { id: 'pl', name: 'Polski', english: 'Polish' },
  { id: 'de', name: 'Deutsch', english: 'German' },
  { id: 'es', name: 'Español', english: 'Spanish' },
  { id: 'fr', name: 'Français', english: 'French' },
];

export interface BookWords {
  contents: string;
  chapter: string;
  /** Cover labels of the three kinds. */
  book: string;
  magazine: string;
  plain: string;
  /** Titles of the pages the app composes. */
  aboutRepo: string;
  aboutChanges: string;
  sources: string;
  sourcesIntro: string;
  allChanges: string;
  overview: string;
  inThisIssue: string;
  issueOf: string;
  /** Labels of the facts. */
  repository: string;
  branch: string;
  folder: string;
  commit: string;
  stars: string;
  license: string;
  languages: string;
  files: string;
  author: string;
  state: string;
  commits: string;
  changed: string;
  description: string;
  map: string;
  diagram: string;
  /** Notes. `{model}`, `{n}`, `{of}` are filled in. */
  writtenBy: string;
  noAi: string;
  partOnly: string;
  noPatch: string;
  cut: string;
  comparison: string;
  commitWord: string;
}

const WORDS: Record<string, BookWords> = {
  uk: {
    contents: 'Зміст',
    chapter: 'Розділ',
    book: 'Книжка про код',
    magazine: 'Журнал про код',
    plain: 'Код як є',
    aboutRepo: 'Про репозиторій',
    aboutChanges: 'Про ці зміни',
    sources: 'Джерела',
    sourcesIntro: 'Файли, з яких написано кожен розділ.',
    allChanges: 'Усі зміни',
    overview: 'Огляд',
    inThisIssue: 'У номері',
    issueOf: 'Випуск від',
    repository: 'Репозиторій',
    branch: 'Гілка',
    folder: 'Тека',
    commit: 'Коміт',
    stars: 'Зірок',
    license: 'Ліцензія',
    languages: 'Мови',
    files: 'Файлів',
    author: 'Автор',
    state: 'Стан',
    commits: 'Коміти',
    changed: 'Змінені файли',
    description: 'Опис',
    map: 'Карта репозиторію: теки й кількість файлів у них',
    diagram: 'Діаграма',
    writtenBy: 'Текст написала модель {model} за файлами репозиторію. У ньому можливі помилки й неточності: важливе звіряйте з кодом.',
    noAi: 'Складено без AI: файли й зміни показано як є.',
    partOnly: 'До книжки ввійшло {n} із {of} файлів: решта не вмістилася в обраний розмір.',
    noPatch: 'Двійковий файл або зміни завеликі, щоб їх показати.',
    cut: 'далі скорочено',
    comparison: 'Порівняння',
    commitWord: 'коміт',
  },
  en: {
    contents: 'Contents',
    chapter: 'Chapter',
    book: 'A book about the code',
    magazine: 'A magazine about the code',
    plain: 'The code as it is',
    aboutRepo: 'About the repository',
    aboutChanges: 'About these changes',
    sources: 'Sources',
    sourcesIntro: 'The files each chapter was written from.',
    allChanges: 'All changes',
    overview: 'Overview',
    inThisIssue: 'In this issue',
    issueOf: 'Issue of',
    repository: 'Repository',
    branch: 'Branch',
    folder: 'Folder',
    commit: 'Commit',
    stars: 'Stars',
    license: 'License',
    languages: 'Languages',
    files: 'Files',
    author: 'Author',
    state: 'State',
    commits: 'Commits',
    changed: 'Changed files',
    description: 'Description',
    map: 'A map of the repository: folders and the number of files in them',
    diagram: 'Diagram',
    writtenBy: 'The text was written by the model {model} from the files of the repository. It may contain mistakes: check what matters against the code.',
    noAi: 'Put together without AI: files and changes are shown as they are.',
    partOnly: 'The book holds {n} of {of} files: the rest did not fit the chosen size.',
    noPatch: 'A binary file, or changes too large to show.',
    cut: 'the rest is cut',
    comparison: 'Comparison',
    commitWord: 'commit',
  },
  pl: {
    contents: 'Spis treści',
    chapter: 'Rozdział',
    book: 'Książka o kodzie',
    magazine: 'Magazyn o kodzie',
    plain: 'Kod taki, jaki jest',
    aboutRepo: 'O repozytorium',
    aboutChanges: 'O tych zmianach',
    sources: 'Źródła',
    sourcesIntro: 'Pliki, na podstawie których napisano każdy rozdział.',
    allChanges: 'Wszystkie zmiany',
    overview: 'Przegląd',
    inThisIssue: 'W numerze',
    issueOf: 'Wydanie z',
    repository: 'Repozytorium',
    branch: 'Gałąź',
    folder: 'Folder',
    commit: 'Commit',
    stars: 'Gwiazdki',
    license: 'Licencja',
    languages: 'Języki',
    files: 'Pliki',
    author: 'Autor',
    state: 'Stan',
    commits: 'Commity',
    changed: 'Zmienione pliki',
    description: 'Opis',
    map: 'Mapa repozytorium: foldery i liczba plików w nich',
    diagram: 'Diagram',
    writtenBy: 'Tekst napisał model {model} na podstawie plików repozytorium. Może zawierać błędy: to, co ważne, sprawdzaj w kodzie.',
    noAi: 'Złożono bez AI: pliki i zmiany pokazano tak, jak są.',
    partOnly: 'Do książki weszło {n} z {of} plików: reszta nie zmieściła się w wybranym rozmiarze.',
    noPatch: 'Plik binarny albo zmiany zbyt duże, by je pokazać.',
    cut: 'dalej skrócono',
    comparison: 'Porównanie',
    commitWord: 'commit',
  },
  de: {
    contents: 'Inhalt',
    chapter: 'Kapitel',
    book: 'Ein Buch über den Code',
    magazine: 'Ein Magazin über den Code',
    plain: 'Der Code, wie er ist',
    aboutRepo: 'Über das Repository',
    aboutChanges: 'Über diese Änderungen',
    sources: 'Quellen',
    sourcesIntro: 'Die Dateien, aus denen jedes Kapitel geschrieben wurde.',
    allChanges: 'Alle Änderungen',
    overview: 'Überblick',
    inThisIssue: 'In dieser Ausgabe',
    issueOf: 'Ausgabe vom',
    repository: 'Repository',
    branch: 'Branch',
    folder: 'Ordner',
    commit: 'Commit',
    stars: 'Sterne',
    license: 'Lizenz',
    languages: 'Sprachen',
    files: 'Dateien',
    author: 'Autor',
    state: 'Status',
    commits: 'Commits',
    changed: 'Geänderte Dateien',
    description: 'Beschreibung',
    map: 'Karte des Repositorys: Ordner und die Zahl der Dateien darin',
    diagram: 'Diagramm',
    writtenBy: 'Den Text hat das Modell {model} anhand der Dateien des Repositorys geschrieben. Er kann Fehler enthalten: Wichtiges bitte am Code prüfen.',
    noAi: 'Ohne KI zusammengestellt: Dateien und Änderungen werden gezeigt, wie sie sind.',
    partOnly: 'Das Buch enthält {n} von {of} Dateien: der Rest passte nicht in die gewählte Größe.',
    noPatch: 'Binärdatei oder zu große Änderungen, um sie zu zeigen.',
    cut: 'ab hier gekürzt',
    comparison: 'Vergleich',
    commitWord: 'Commit',
  },
  es: {
    contents: 'Índice',
    chapter: 'Capítulo',
    book: 'Un libro sobre el código',
    magazine: 'Una revista sobre el código',
    plain: 'El código tal cual',
    aboutRepo: 'Sobre el repositorio',
    aboutChanges: 'Sobre estos cambios',
    sources: 'Fuentes',
    sourcesIntro: 'Los archivos a partir de los cuales se escribió cada capítulo.',
    allChanges: 'Todos los cambios',
    overview: 'Visión general',
    inThisIssue: 'En este número',
    issueOf: 'Número del',
    repository: 'Repositorio',
    branch: 'Rama',
    folder: 'Carpeta',
    commit: 'Commit',
    stars: 'Estrellas',
    license: 'Licencia',
    languages: 'Lenguajes',
    files: 'Archivos',
    author: 'Autor',
    state: 'Estado',
    commits: 'Commits',
    changed: 'Archivos cambiados',
    description: 'Descripción',
    map: 'Mapa del repositorio: carpetas y número de archivos en ellas',
    diagram: 'Diagrama',
    writtenBy: 'El texto lo escribió el modelo {model} a partir de los archivos del repositorio. Puede contener errores: lo importante, compruébelo en el código.',
    noAi: 'Compuesto sin IA: los archivos y los cambios se muestran tal cual.',
    partOnly: 'El libro incluye {n} de {of} archivos: el resto no cupo en el tamaño elegido.',
    noPatch: 'Archivo binario o cambios demasiado grandes para mostrarlos.',
    cut: 'el resto se ha recortado',
    comparison: 'Comparación',
    commitWord: 'commit',
  },
  fr: {
    contents: 'Sommaire',
    chapter: 'Chapitre',
    book: 'Un livre sur le code',
    magazine: 'Un magazine sur le code',
    plain: 'Le code tel quel',
    aboutRepo: 'À propos du dépôt',
    aboutChanges: 'À propos de ces changements',
    sources: 'Sources',
    sourcesIntro: 'Les fichiers à partir desquels chaque chapitre a été écrit.',
    allChanges: 'Tous les changements',
    overview: 'Vue d’ensemble',
    inThisIssue: 'Dans ce numéro',
    issueOf: 'Numéro du',
    repository: 'Dépôt',
    branch: 'Branche',
    folder: 'Dossier',
    commit: 'Commit',
    stars: 'Étoiles',
    license: 'Licence',
    languages: 'Langages',
    files: 'Fichiers',
    author: 'Auteur',
    state: 'État',
    commits: 'Commits',
    changed: 'Fichiers modifiés',
    description: 'Description',
    map: 'Carte du dépôt : les dossiers et le nombre de fichiers qu’ils contiennent',
    diagram: 'Diagramme',
    writtenBy: 'Le texte a été écrit par le modèle {model} à partir des fichiers du dépôt. Il peut contenir des erreurs : vérifiez l’essentiel dans le code.',
    noAi: 'Composé sans IA : les fichiers et les changements sont montrés tels quels.',
    partOnly: 'Le livre contient {n} fichiers sur {of} : le reste ne tenait pas dans la taille choisie.',
    noPatch: 'Fichier binaire ou changements trop volumineux pour être montrés.',
    cut: 'la suite est coupée',
    comparison: 'Comparaison',
    commitWord: 'commit',
  },
};

export const bookLang = (id: string): BookLang => BOOK_LANGS.find((l) => l.id === id) ?? BOOK_LANGS[0];
export const bookWords = (id: string): BookWords => WORDS[id] ?? WORDS.uk;
