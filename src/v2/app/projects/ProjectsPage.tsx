import { EmptyState } from "../components/EmptyState";
import { useV2Workspace } from "../state/V2WorkspaceProvider";
import { ProjectCard } from "./ProjectCard";

export function ProjectsPage() {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;

  const archived = new Set(state.workspace.visibility.archivedProjectIds);
  const projects = state.workspace.projects
    .filter(({ id }) => !archived.has(id))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    )
    .filter((project, index, records) =>
      records.findIndex(({ id }) => id === project.id) === index);

  return (
    <article className="v2-projects-page v2-route-page" aria-labelledby="v2-projects-title">
      <header className="v2-page-heading">
        <p className="v2-eyebrow">Direction → Bet → Plan → Execute → Evidence → Close</p>
        <h1 id="v2-projects-title">Projects</h1>
        <p className="v2-page-summary">
          Follow the next explicit gate for each meaningful outcome. Holds stay visible;
          lifecycle state changes only through bounded commands.
        </p>
      </header>
      {projects.length === 0 ? (
        <EmptyState
          title="No active Projects"
          description="Classify an Inbox capture as a Project to begin with Direction."
        />
      ) : (
        <section className="v2-project-grid" aria-label="Active projects">
          {projects.map((project) => (
            <ProjectCard key={project.id} workspace={state.workspace} project={project} />
          ))}
        </section>
      )}
    </article>
  );
}
