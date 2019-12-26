import fs from 'fs-extra';
import path from 'path';
import { deserialize, serialize } from 'blister.js/esm/serialize';
import { convertLegacyPlaylist } from 'blister.js/esm/convert';
import { validateMagicNumber } from 'blister.js/esm/magic';
import { BeatmapType, IBeatmap, IPlaylist } from 'blister.js/esm/spec';
import { ILegacyPlaylist } from 'blister.js/esm/legacy';
import { PlaylistLocal, PlaylistLocalMap, PlaylistMapImportError } from '@/libraries/playlist/PlaylistLocal';
import BeatSaverAPI from '@/libraries/net/beatsaver/BeatSaverAPI';
import Progress, { ProgressStatus } from '@/libraries/common/Progress';

const PLAYLIST_EXTENSION_NAME = 'blist';

export default class PlaylistLoader {
  public static async Load(
    filepath: string,
    forceConvertIfNeeded: boolean = false,
    progress?: Progress,
  ) : Promise<PlaylistLocal | undefined> {
    if (!await fs.pathExists(filepath)) {
      return undefined;
    }

    const buffer = await fs.readFile(filepath);
    const oldFormat = await PlaylistLoader.IsOldFormat(buffer);
    let playlist: IPlaylist;

    if (oldFormat) {
      try {
        const legacyPlaylist = JSON.parse(buffer.toString()) as ILegacyPlaylist;
        playlist = convertLegacyPlaylist(legacyPlaylist);
      } catch (e) {
        return undefined;
      }
    } else {
      playlist = await deserialize(buffer);
    }

    const output = await PlaylistLoader.ConvertToPlaylistLocal(playlist, progress);

    if (oldFormat && forceConvertIfNeeded) {
      await PlaylistLoader.ConvertPlaylistFile(filepath, output);
    }

    output.path = filepath;

    return output;
  }

  public static async Save(filepath: string, playlist: PlaylistLocal): Promise<boolean> {
    try {
      const blisterPlaylist = await PlaylistLoader.ConvertToPlaylistBlister(playlist);
      const buffer = await serialize(blisterPlaylist);
      await fs.writeFile(filepath, buffer);
    } catch (e) {
      return false;
    }

    return true;
  }

  private static async IsOldFormat(buffer: Buffer) {
    try {
      validateMagicNumber(buffer);
      return false;
    } catch (e) {
      return true;
    }
  }

  private static async ConvertToPlaylistLocal(
    playlist: IPlaylist,
    progress: Progress = new Progress(),
  ): Promise<PlaylistLocal> {
    const output = {} as PlaylistLocal;

    output.title = playlist.title;
    output.author = playlist.author;
    output.description = playlist.description;
    output.cover = playlist.cover;

    progress.status = ProgressStatus.Running;
    progress.total = playlist.maps.length;

    output.maps = await Promise.all(playlist.maps.map(async (mapToConvert: IBeatmap) => {
      const map = { dateAdded: mapToConvert.dateAdded } as PlaylistLocalMap;

      switch (mapToConvert.type) {
        case BeatmapType.Key:
          map.online = await BeatSaverAPI.Singleton.getBeatmapByKey(mapToConvert.key.toString(16))
            || null;
          break;

        case BeatmapType.Hash:
          map.online = await BeatSaverAPI.Singleton.getBeatmapByHash(mapToConvert.hash.toString('hex'))
            || null;
          break;

        case BeatmapType.Zip:
          map.error = PlaylistMapImportError.BeatmapTypeZipNotSupported;
          break;

        case BeatmapType.LevelID:
          map.error = PlaylistMapImportError.BeatmapTypeLevelIdNotSupported;
          break;

        default:
          map.error = PlaylistMapImportError.BeatmapTypeUnknown;
          break;
      }

      progress.done += 1;

      return map;
    }));

    progress.status = ProgressStatus.Completed;
    return output;
  }

  private static async ConvertToPlaylistBlister(playlist: PlaylistLocal): Promise<IPlaylist> {
    const output = {} as IPlaylist;

    output.title = playlist.title;
    output.author = playlist.author;
    output.description = playlist.description;
    output.cover = playlist.cover;

    output.maps = playlist.maps.map((map: PlaylistLocalMap) => {
      if (map.online === undefined) {
        return undefined;
      }

      const hash = map.online?.hash || '';
      return {
        dateAdded: map.dateAdded,
        type: BeatmapType.Hash,
        hash: Buffer.from(hash.toLowerCase(), 'hex'),
      } as IBeatmap;
    }).filter((map: IBeatmap | undefined) => map !== undefined) as IBeatmap[];

    return output;
  }

  private static async ConvertPlaylistFile(filepath: string, playlist: PlaylistLocal) {
    const filename = `${path.parse(filepath).name}.${PLAYLIST_EXTENSION_NAME}`;
    const newFilepath = path.join(path.parse(filepath).dir, filename);
    const done = await this.Save(newFilepath, playlist);

    if (done) {
      await fs.unlink(filepath);
    }
  }
}