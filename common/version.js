// The commit the site was published from: { number, commit, time }. number is the commit's position on main
// (git rev-list --count), commit its full hash and time its commit time in UTC. The deploy workflow
// (.github/workflows/pages.yml) writes it with `python3 stamp_versions.py --page-version`. The copy in git stays
// null, and `stamp_versions.py --check` fails if it isn't.
/** @type {{ number: number, commit: string, time: string } | null} */
export const PAGE = null;
