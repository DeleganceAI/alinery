use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::{artifacts_dir, safe_component};
use crate::subtask::read_task_relationships;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactTreeNodeKind {
    Owned,
    Attachment,
    SubtaskFolder,
    Referenced,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactTreeSource {
    Owned,
    ParentContext,
    ActiveChild,
    Snapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactTreeNode {
    pub id: String,
    pub kind: ArtifactTreeNodeKind,
    pub label: String,
    pub owner_task_slug: String,
    pub source: ArtifactTreeSource,
    pub children: Vec<ArtifactTreeNode>,
}

#[derive(Clone)]
struct ResolvedNode {
    node: ArtifactTreeNode,
    path: Option<PathBuf>,
    containment_root: Option<PathBuf>,
    children: Vec<ResolvedNode>,
}

fn artifact_error(detail: impl AsRef<str>) -> String {
    format!("artifact tree error: {}", detail.as_ref())
}

fn node_id(viewing_slug: &str, owner_slug: &str, kind: ArtifactTreeNodeKind, source: ArtifactTreeSource, key: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in format!("{viewing_slug}\0{owner_slug}\0{kind:?}\0{source:?}\0{key}").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("artifact-{hash:016x}")
}

fn safe_name(path: &Path) -> Result<String, String> {
    let name = path.file_name().and_then(|name| name.to_str()).ok_or_else(|| artifact_error("non-UTF-8 path component"))?;
    if safe_component(name) != Some(name) {
        return Err(artifact_error(format!("unsafe path component '{name}'")));
    }
    Ok(name.to_string())
}

fn checked_entries(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let metadata = fs::symlink_metadata(dir).map_err(|error| artifact_error(format!("inspect {}: {error}", dir.display())))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(artifact_error(format!("{} is not a regular directory", dir.display())));
    }
    let mut entries = fs::read_dir(dir)
        .map_err(|error| artifact_error(format!("read {}: {error}", dir.display())))?
        .map(|entry| entry.map(|entry| entry.path()).map_err(|error| artifact_error(error.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    Ok(entries)
}

fn record_file(
    viewing_slug: &str,
    owner_slug: &str,
    path: PathBuf,
    root: &Path,
    source: ArtifactTreeSource,
    kind: ArtifactTreeNodeKind,
    key: &str,
) -> Result<ResolvedNode, String> {
    let label = safe_name(&path)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| artifact_error(format!("inspect {}: {error}", path.display())))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(artifact_error(format!("{} is not a regular file", path.display())));
    }
    Ok(ResolvedNode {
        node: ArtifactTreeNode {
            id: node_id(viewing_slug, owner_slug, kind, source, key),
            kind,
            label,
            owner_task_slug: owner_slug.to_string(),
            source,
            children: Vec::new(),
        },
        path: Some(path),
        containment_root: Some(root.to_path_buf()),
        children: Vec::new(),
    })
}

fn attachment_folder(viewing_slug: &str, owner_slug: &str, dir: &Path, root: &Path, source: ArtifactTreeSource, key: &str) -> Result<Option<ResolvedNode>, String> {
    let mut children = Vec::new();
    for path in checked_entries(dir)? {
        let label = safe_name(&path)?;
        children.push(record_file(
            viewing_slug,
            owner_slug,
            path,
            root,
            source,
            ArtifactTreeNodeKind::Attachment,
            &format!("{key}/{label}"),
        )?);
    }
    if children.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        ResolvedNode {
            node: ArtifactTreeNode {
                id: node_id(viewing_slug, owner_slug, ArtifactTreeNodeKind::SubtaskFolder, source, key),
                kind: ArtifactTreeNodeKind::SubtaskFolder,
                label: "Attachments".into(),
                owner_task_slug: owner_slug.to_string(),
                source,
                children: Vec::new(),
            },
            path: None,
            containment_root: None,
            children: Vec::new(),
        }
        .with_children(children),
    ))
}

impl ResolvedNode {
    fn with_children(mut self, children: Vec<ResolvedNode>) -> Self {
        self.node.children = children.iter().map(|child| child.node.clone()).collect();
        self.children = children;
        self
    }
}

fn snapshot_folder(viewing_slug: &str, path: &Path, key: &str) -> Result<ResolvedNode, String> {
    let child_slug = safe_name(path)?;
    let children = owned_nodes(viewing_slug, &child_slug, path, ArtifactTreeSource::Snapshot, true, key)?;
    Ok(ResolvedNode {
        node: ArtifactTreeNode {
            id: node_id(viewing_slug, &child_slug, ArtifactTreeNodeKind::SubtaskFolder, ArtifactTreeSource::Snapshot, key),
            kind: ArtifactTreeNodeKind::SubtaskFolder,
            label: child_slug.clone(),
            owner_task_slug: child_slug,
            source: ArtifactTreeSource::Snapshot,
            children: children.iter().map(|child| child.node.clone()).collect(),
        },
        path: None,
        containment_root: None,
        children,
    })
}

fn owned_nodes(viewing_slug: &str, owner_slug: &str, root: &Path, source: ArtifactTreeSource, referenced: bool, key_prefix: &str) -> Result<Vec<ResolvedNode>, String> {
    let mut nodes = Vec::new();
    for path in checked_entries(root)? {
        let label = safe_name(&path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| artifact_error(format!("inspect {}: {error}", path.display())))?;
        if metadata.file_type().is_symlink() {
            return Err(artifact_error(format!("symlink rejected: {}", path.display())));
        }
        let key = format!("{key_prefix}/{label}");
        if metadata.is_file() && label == crate::task::RELATED_TASKS_MARKDOWN {
            continue;
        }
        if metadata.is_file() {
            nodes.push(record_file(
                viewing_slug,
                owner_slug,
                path,
                root,
                source,
                if referenced { ArtifactTreeNodeKind::Referenced } else { ArtifactTreeNodeKind::Owned },
                &key,
            )?);
        } else if metadata.is_dir() && label == "attachments" {
            if let Some(folder) = attachment_folder(viewing_slug, owner_slug, &path, root, source, &key)? {
                nodes.push(folder);
            }
        } else if metadata.is_dir() && label == "subtasks" {
            for snapshot in checked_entries(&path)? {
                let snapshot_label = safe_name(&snapshot)?;
                nodes.push(snapshot_folder(viewing_slug, &snapshot, &format!("{key}/{snapshot_label}"))?);
            }
        } else {
            return Err(artifact_error(format!("unexpected directory {}", path.display())));
        }
    }
    nodes.sort_by(|left, right| left.node.label.cmp(&right.node.label).then_with(|| left.node.id.cmp(&right.node.id)));
    Ok(nodes)
}

fn relationship_folder(viewing_slug: &str, owner_slug: &str, label: &str, source: ArtifactTreeSource, children: Vec<ResolvedNode>) -> ResolvedNode {
    ResolvedNode {
        node: ArtifactTreeNode {
            id: node_id(viewing_slug, owner_slug, ArtifactTreeNodeKind::SubtaskFolder, source, label),
            kind: ArtifactTreeNodeKind::SubtaskFolder,
            label: label.to_string(),
            owner_task_slug: owner_slug.to_string(),
            source,
            children: Vec::new(),
        },
        path: None,
        containment_root: None,
        children: Vec::new(),
    }
    .with_children(children)
}

fn build_tree(repo: &Path, viewing_slug: &str) -> Result<Vec<ResolvedNode>, String> {
    if safe_component(viewing_slug) != Some(viewing_slug) {
        return Err(artifact_error("invalid viewing task slug"));
    }
    let relationships = read_task_relationships(repo, viewing_slug)?;
    let own_root = artifacts_dir(repo, viewing_slug);
    let mut nodes = owned_nodes(viewing_slug, viewing_slug, &own_root, ArtifactTreeSource::Owned, false, "owned")?;

    if let Some(parent) = relationships.parent_task {
        let parent_root = artifacts_dir(repo, &parent.slug);
        let children = owned_nodes(viewing_slug, &parent.slug, &parent_root, ArtifactTreeSource::ParentContext, true, "parent-context")?;
        nodes.push(relationship_folder(
            viewing_slug,
            &parent.slug,
            "Parent context",
            ArtifactTreeSource::ParentContext,
            children,
        ));
    }
    for child in relationships.active_subtasks {
        let child_root = artifacts_dir(repo, &child.slug);
        let children = owned_nodes(viewing_slug, &child.slug, &child_root, ArtifactTreeSource::ActiveChild, true, "active-child")?;
        nodes.push(relationship_folder(viewing_slug, &child.slug, &child.slug, ArtifactTreeSource::ActiveChild, children));
    }
    nodes.sort_by(|left, right| left.node.label.cmp(&right.node.label).then_with(|| left.node.id.cmp(&right.node.id)));
    let mut ids = HashSet::new();
    fn collect(node: &ArtifactTreeNode, ids: &mut HashSet<String>) -> Result<(), String> {
        if !ids.insert(node.id.clone()) {
            return Err(artifact_error("node identity collision"));
        }
        for child in &node.children {
            collect(child, ids)?;
        }
        Ok(())
    }
    for node in &nodes {
        collect(&node.node, &mut ids)?;
    }
    Ok(nodes)
}

fn find_record(nodes: &[ResolvedNode], node_id: &str) -> Option<ResolvedNode> {
    for resolved in nodes {
        if resolved.node.id == node_id {
            return Some(resolved.clone());
        }
        if let Some(record) = find_record(&resolved.children, node_id) {
            return Some(record);
        }
    }
    None
}

fn resolve_file(repo: &Path, viewing_slug: &str, node_id: &str) -> Result<(ArtifactTreeNode, PathBuf), String> {
    if !node_id.starts_with("artifact-") || node_id.len() != 25 {
        return Err(artifact_error("unknown node identity"));
    }
    let nodes = build_tree(repo, viewing_slug)?;
    let record = find_record(&nodes, node_id).ok_or_else(|| artifact_error("unknown node identity"))?;
    let path = record.path.ok_or_else(|| artifact_error("node is not an openable file"))?;
    let root = record.containment_root.ok_or_else(|| artifact_error("node has no containment root"))?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| artifact_error(format!("inspect {}: {error}", path.display())))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(artifact_error("node is no longer a regular file"));
    }
    let canonical_root = root.canonicalize().map_err(|error| artifact_error(format!("resolve {}: {error}", root.display())))?;
    let canonical_path = path.canonicalize().map_err(|error| artifact_error(format!("resolve {}: {error}", path.display())))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(artifact_error("node escapes its artifact root"));
    }
    Ok((record.node, canonical_path))
}

pub fn list_task_artifact_tree(repo: &Path, viewing_slug: &str) -> Result<Vec<ArtifactTreeNode>, String> {
    build_tree(repo, viewing_slug).map(|nodes| nodes.into_iter().map(|node| node.node).collect())
}

pub fn read_task_artifact_node(repo: &Path, viewing_slug: &str, node_id: &str) -> Result<String, String> {
    let (node, path) = resolve_file(repo, viewing_slug, node_id)?;
    if node.kind == ArtifactTreeNodeKind::Attachment {
        return Err(artifact_error("attachments must be revealed, not read as artifact content"));
    }
    fs::read_to_string(&path).map_err(|error| artifact_error(format!("read {}: {error}", path.display())))
}

pub fn artifact_node_path(repo: &Path, viewing_slug: &str, node_id: &str) -> Result<String, String> {
    let (node, path) = resolve_file(repo, viewing_slug, node_id)?;
    if node.kind != ArtifactTreeNodeKind::Attachment {
        return Err(artifact_error("only attachments have revealable paths"));
    }
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::write_task;
    use crate::types::Task;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn repo(name: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let repo = std::env::temp_dir().join(format!("alinery-artifact-tree-{name}-{nonce}"));
        fs::create_dir_all(&repo).unwrap();
        repo
    }

    fn task(repo: &Path, slug: &str, parent: &str, child: &str) {
        let task = Task {
            name: slug.into(),
            slug: slug.into(),
            branch: slug.into(),
            worktree: repo.join("worktrees").join(slug).display().to_string(),
            has_worktree: true,
            created: 1,
            playbook: "superdevelop".into(),
            parent_task: parent.into(),
            active_subtask: child.into(),
            ..Default::default()
        };
        write_task(repo, &task).unwrap();
        fs::create_dir_all(artifacts_dir(repo, slug)).unwrap();
    }

    fn find<'a>(nodes: &'a [ArtifactTreeNode], label: &str) -> &'a ArtifactTreeNode {
        fn find_optional<'a>(nodes: &'a [ArtifactTreeNode], label: &str) -> Option<&'a ArtifactTreeNode> {
            for node in nodes {
                if node.label == label {
                    return Some(node);
                }
                if let Some(found) = find_optional(&node.children, label) {
                    return Some(found);
                }
            }
            None
        }
        find_optional(nodes, label).unwrap_or_else(|| panic!("missing node {label}"))
    }

    #[test]
    fn artifact_tree_exposes_owned_parent_context_and_live_child_without_cycles() {
        let repo = repo("relationships");
        task(&repo, "parent", "", "child");
        task(&repo, "child", "parent", "");
        fs::write(artifacts_dir(&repo, "parent").join("01-parent.md"), "parent").unwrap();
        fs::write(artifacts_dir(&repo, "child").join("01-child.md"), "child").unwrap();

        let parent_tree = list_task_artifact_tree(&repo, "parent").unwrap();
        let live = find(&parent_tree, "child");
        assert_eq!(live.source, ArtifactTreeSource::ActiveChild);
        assert_eq!(find(&live.children, "01-child.md").kind, ArtifactTreeNodeKind::Referenced);

        let child_tree = list_task_artifact_tree(&repo, "child").unwrap();
        let context = find(&child_tree, "Parent context");
        assert_eq!(context.source, ArtifactTreeSource::ParentContext);
        assert_eq!(find(&context.children, "01-parent.md").owner_task_slug, "parent");
        assert!(!context.children.iter().any(|node| node.source == ArtifactTreeSource::ActiveChild));
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn artifact_tree_switches_live_child_to_same_snapshot_label_and_keeps_nested_history() {
        let repo = repo("snapshot");
        task(&repo, "a", "", "b");
        task(&repo, "b", "a", "");
        let live = find(&list_task_artifact_tree(&repo, "a").unwrap(), "b").clone();
        assert_eq!(live.source, ArtifactTreeSource::ActiveChild);

        let snapshot = artifacts_dir(&repo, "a").join("subtasks/b");
        fs::create_dir_all(snapshot.join("subtasks/c")).unwrap();
        fs::write(snapshot.join("01-b.md"), "b").unwrap();
        fs::write(snapshot.join("subtasks/c/01-c.md"), "c").unwrap();
        let mut a = crate::task::read_task(&repo, "a").unwrap();
        let mut b = crate::task::read_task(&repo, "b").unwrap();
        a.active_subtask.clear();
        b.parent_task.clear();
        b.archived = true;
        write_task(&repo, &a).unwrap();
        write_task(&repo, &b).unwrap();

        let completed = find(&list_task_artifact_tree(&repo, "a").unwrap(), "b").clone();
        assert_eq!(completed.label, live.label);
        assert_eq!(completed.source, ArtifactTreeSource::Snapshot);
        assert_eq!(find(&completed.children, "c").source, ArtifactTreeSource::Snapshot);
        assert_eq!(find(&completed.children, "01-c.md").owner_task_slug, "c");
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn artifact_tree_resolvers_reject_tampering_wrong_kind_and_attachment_content() {
        let repo = repo("resolve");
        task(&repo, "task", "", "");
        task(&repo, "other", "", "");
        fs::write(artifacts_dir(&repo, "task").join("01-owned.md"), "owned").unwrap();
        fs::create_dir_all(artifacts_dir(&repo, "task").join("attachments")).unwrap();
        fs::write(artifacts_dir(&repo, "task").join("attachments/input.txt"), "attachment").unwrap();
        let tree = list_task_artifact_tree(&repo, "task").unwrap();
        let owned = find(&tree, "01-owned.md");
        let attachment = find(&tree, "input.txt");
        let folder = find(&tree, "Attachments");

        assert_eq!(read_task_artifact_node(&repo, "task", &owned.id).unwrap(), "owned");
        assert!(read_task_artifact_node(&repo, "task", &attachment.id).unwrap_err().contains("must be revealed"));
        assert!(artifact_node_path(&repo, "task", &owned.id).unwrap_err().contains("only attachments"));
        assert!(artifact_node_path(&repo, "task", &attachment.id).unwrap().ends_with("input.txt"));
        assert!(read_task_artifact_node(&repo, "task", &folder.id).is_err());
        assert!(read_task_artifact_node(&repo, "task", "artifact-0000000000000000").is_err());
        assert!(read_task_artifact_node(&repo, "other", &owned.id).is_err());
        assert!(read_task_artifact_node(&repo, "../task", &owned.id).is_err());
        let _ = fs::remove_dir_all(repo);
    }

    #[cfg(unix)]
    #[test]
    fn artifact_tree_rejects_symlinks_at_listing_and_reopen() {
        use std::os::unix::fs::symlink;

        let repo = repo("symlink");
        task(&repo, "task", "", "");
        let file = artifacts_dir(&repo, "task").join("01-owned.md");
        fs::write(&file, "owned").unwrap();
        let id = find(&list_task_artifact_tree(&repo, "task").unwrap(), "01-owned.md").id.clone();
        fs::remove_file(&file).unwrap();
        symlink("/etc/hosts", &file).unwrap();
        assert!(list_task_artifact_tree(&repo, "task").unwrap_err().contains("symlink rejected"));
        assert!(read_task_artifact_node(&repo, "task", &id).is_err());
        let _ = fs::remove_dir_all(repo);
    }
}
