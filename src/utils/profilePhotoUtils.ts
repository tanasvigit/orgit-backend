import { resolveToUrl } from '../services/s3StorageService';

/** Resolve stored profile photo path/S3 key to a client-loadable URL. */
export function resolveProfilePhotoForClient(
  stored: string | null | undefined
): string | null {
  if (!stored || typeof stored !== 'string') return null;
  const trimmed = stored.trim();
  if (!trimmed) return null;
  return resolveToUrl(trimmed) || trimmed;
}

export function mapAssigneesWithResolvedPhotos(assignees: unknown): any[] {
  if (!Array.isArray(assignees)) return [];
  return assignees
    .filter((entry) => entry && typeof entry === 'object')
    .map((assignee: any) => {
      const resolved = resolveProfilePhotoForClient(
        assignee.profile_photo_url || assignee.profile_photo || assignee.profilePhotoUrl
      );
      return {
        ...assignee,
        profile_photo: resolved,
        profile_photo_url: resolved,
        profilePhotoUrl: resolved,
        photoUrl: resolved,
      };
    });
}

export function enrichTaskWithResolvedProfilePhotos(task: Record<string, any>): Record<string, any> {
  const creatorPhoto = resolveProfilePhotoForClient(
    task.creator_photo || task.creatorPhoto
  );
  const reportingMemberPhoto = resolveProfilePhotoForClient(
    task.reporting_member_photo || task.reportingMemberPhoto
  );
  return {
    ...task,
    assignees: mapAssigneesWithResolvedPhotos(task.assignees),
    creator_photo: creatorPhoto,
    creatorPhoto: creatorPhoto,
    reporting_member_photo: reportingMemberPhoto,
    reportingMemberPhoto: reportingMemberPhoto,
  };
}
