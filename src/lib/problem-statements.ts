/**
 * The 20 Hacktoberfest Hack Day problem statements, from the event deck
 * ("Hacktoberfest26_ProblemStatements_Updated.pdf"). Public event content.
 */
export type ProblemStatement = { number: number; title: string; problem: string; whoItHelps: string; whatToBuild: string };

export const PROBLEM_STATEMENTS: ProblemStatement[] = [
  {
    number: 1,
    title: "Bolo: Voice Help for Everyday Government Services",
    problem: "People who can't type or read long forms, often with poor internet, can't easily get reliable answers about public services and depend on middlemen.",
    whoItHelps: "Rural and semi-urban users, village help-desk volunteers",
    whatToBuild: "Help people who can't easily type or read long forms get reliable answers about public services by speaking in their own language, and point them to the official helpline when there is no answer.",
  },
  {
    number: 2,
    title: "Handwritten Answer-Sheet Grader",
    problem: "Teachers in small schools and tuition centers grade many handwritten answers by hand.",
    whoItHelps: "Teachers",
    whatToBuild: "Help teachers grade handwritten answers faster and fairly against their own marking scheme, with feedback they can review and edit.",
  },
  {
    number: 3,
    title: "PII redaction for Indian documents and languages",
    problem: "People paste documents with names, IDs and account numbers into cloud chatbots.",
    whoItHelps: "Anyone using cloud AI with private documents",
    whatToBuild: "Help people use online chat tools with private documents without exposing names, IDs or account numbers.",
  },
  {
    number: 4,
    title: "Smart Meeting Assistant",
    problem: "After meetings, teams forget what was decided and who owns what. Most AI note-takers are paid, closed tools that send recordings to someone else's servers.",
    whoItHelps: "Teams and student groups",
    whatToBuild: "Help teams remember what was decided in a meeting and who owns each next step, without sending their recordings to a closed outside service.",
  },
  {
    number: 5,
    title: "Pesticide Label Reader for Indian Farmers",
    problem: "Pesticide labels are dense and often hard to read in English or mixed languages, and misuse causes illness, crop damage and wasted money.",
    whoItHelps: "Small and low-literacy farmers, farm workers, agri-input shop staff",
    whatToBuild: "Help farmers understand a pesticide label, including the right dose for their tank, the waiting period and the safety steps, in their own language.",
  },
  {
    number: 6,
    title: "Legal Rights Awareness Assistant",
    problem: "Most people don't know their basic legal rights, legal text is long and hard to read, and asking a lawyer even a simple question costs money.",
    whoItHelps: "Citizens, tenants, workers, small shop owners",
    whatToBuild: "Help ordinary people understand their basic legal rights in simple language, in the language they speak, with answers they can trace back to a reliable source.",
  },
  {
    number: 7,
    title: "Policy and HR Helpdesk Bot for Government Offices",
    problem: "Staff keep asking the same questions about leave, travel claims and service rules, and the answers sit in long circulars that nobody can find.",
    whoItHelps: "Government and office employees, admin and HR teams",
    whatToBuild: "Give office staff quick, reliable answers to everyday policy and HR questions, so they don't have to search long circulars or keep asking the same people.",
  },
  {
    number: 8,
    title: "Career Guidance Companion for School Students",
    problem: "Students choose streams and careers because of peer pressure or marks, since school counsellors are few and career information is scattered.",
    whoItHelps: "School students (grades 9 to 12), parents, teachers",
    whatToBuild: "Help school students discover career options that fit their interests and strengths, and understand the next steps, with clear reasons for every suggestion.",
  },
  {
    number: 9,
    title: "Private Wellness Check-In for Hostel Students",
    problem: "Students rarely approach counsellors until things get serious, and they don't want to share personal thoughts with cloud apps.",
    whoItHelps: "Hostel and college students, campus counsellors",
    whatToBuild: "Give students a private, safe space to check in on how they feel each day, notice patterns over time, and reach a counsellor or helpline quickly when they need one. It supports professional help and never replaces it.",
  },
  {
    number: 10,
    title: "Look-Alike Website Detector",
    problem: "Fake websites copy the look of banks and government portals, and people notice the wrong web address only after it is too late.",
    whoItHelps: "Everyday internet users, small businesses, bank customers",
    whatToBuild: "Help people tell whether a website is genuine or a fake copy, and explain the warning signs in plain words.",
  },
  {
    number: 11,
    title: "Sign-to-Speech Translator for Indian Sign Language",
    problem: "People who use sign language struggle to communicate with those who don't, at hospitals, banks and offices.",
    whoItHelps: "Deaf and hard-of-hearing people, shop and service staff",
    whatToBuild: "Help sign-language users and people who don't know sign language communicate, by turning signs into text and speech that anyone can understand.",
  },
  {
    number: 12,
    title: "Network Anomaly Spotter",
    problem: "Attackers often get into a network without triggering known warning signs, so teams notice only after the damage is done.",
    whoItHelps: "Small IT teams, college and small-office network admins",
    whatToBuild: "Help small IT teams notice early that something is wrong on their network, even when the attack doesn't match any known warning sign, and understand what to check first.",
  },
  {
    number: 13,
    title: "Floor Plan to 3D Viewer",
    problem: "A flat 2D floor plan is hard for most people to picture, and building a 3D model by hand takes hours.",
    whoItHelps: "Architecture students, builders, home buyers",
    whatToBuild: "Help people picture a building by turning a flat floor plan into a 3D view they can explore.",
  },
  {
    number: 14,
    title: "Scheme Eligibility Navigator",
    problem: "Citizens miss benefits because scheme rules are scattered across long PDFs in formal English or Hindi.",
    whoItHelps: "Citizens, village help-desk volunteers",
    whatToBuild: "Help citizens find out which government schemes they qualify for, why, and which documents to carry, in their own language.",
  },
  {
    number: 15,
    title: "Civic Complaint Triage and Routing",
    problem: "Municipal portals receive thousands of free-text complaints (potholes, garbage, water leaks) that are sorted by hand.",
    whoItHelps: "Municipal staff, ward officers, residents",
    whatToBuild: "Help municipal teams sort, prioritize and route incoming complaints quickly, and spot repeated complaints about the same issue.",
  },
  {
    number: 16,
    title: "Mandi Price and Selling Assistant",
    problem: "Farmers sell at the nearest mandi without knowing prices elsewhere.",
    whoItHelps: "Farmers, farmer groups, traders",
    whatToBuild: "Help farmers decide where and when to sell their produce for the best return, with the numbers behind the advice.",
  },
  {
    number: 17,
    title: "Local, Private Pull Request Reviewer",
    problem: "Teams can't send proprietary code to cloud AI services, so they miss out on automated code review.",
    whoItHelps: "Developers, student project teams, small companies",
    whatToBuild: "Help teams get useful, trustworthy review of their code changes without sharing their code with outside services.",
  },
  {
    number: 18,
    title: "Documentation Drift Detector",
    problem: "READMEs and API docs go stale as code changes, so new contributors follow wrong instructions.",
    whoItHelps: "Open-source maintainers, new contributors",
    whatToBuild: "Help maintainers and new contributors spot where READMEs and API docs no longer match the code, so instructions stay accurate and newcomers don't follow outdated steps.",
  },
  {
    number: 19,
    title: "Dependency Upgrade and Migration Assistant",
    problem: "Projects stay on outdated or vulnerable library versions because upgrades break things.",
    whoItHelps: "Developers, maintainers",
    whatToBuild: "Help developers upgrade outdated or vulnerable libraries safely, by showing what is likely to break, suggesting the code changes needed, and letting them review each change before it is applied.",
  },
  {
    number: 20,
    title: "Open-Source Contribution Finder",
    problem: "Beginners want to contribute to open source but don't know where to start, and searching issues by hand is slow. Many issues are too hard, out of date or already taken.",
    whoItHelps: "Students and first-time contributors",
    whatToBuild: "Help beginners find open-source issues that match their skills and are actually open and ready to work on, and understand why each one fits.",
  },
];

const BY_NUMBER = new Map(PROBLEM_STATEMENTS.map((p) => [p.number, p]));

/** Statements referenced in an organiser's match note, e.g. "#3 PII Redaction; #10 Look-Alike…" → [#3, #10]. */
export function statementsIn(note: string | null | undefined): ProblemStatement[] {
  const nums = [...(note ?? "").matchAll(/#(\d{1,2})\b/g)].map((m) => Number(m[1]));
  return [...new Set(nums)].map((n) => BY_NUMBER.get(n)).filter((p): p is ProblemStatement => !!p);
}
