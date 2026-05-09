import json
import re
import shutil
import subprocess
import uuid
from pathlib import Path


try:
    import folder_paths
except ImportError:
    folder_paths = None


class ComfyVideoCombineError(RuntimeError):
    pass


class VideoCombinerFFmpeg:
    CATEGORY = "video/ffmpeg"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("output_path",)
    FUNCTION = "combine_videos"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_1": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": "Path to the first video file",
                    },
                ),
                "video_2": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": "Path to the second video file",
                    },
                ),
                "mode": (["concatenate", "side_by_side", "top_bottom"],),
                "audio": (["first", "second", "mix", "none"],),
                "duration": (["longest", "shortest"],),
                "output_filename": (
                    "STRING",
                    {
                        "default": "combined_video.mp4",
                        "multiline": False,
                    },
                ),
            },
            "optional": {
                "width": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 8192,
                        "step": 2,
                        "display": "number",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 8192,
                        "step": 2,
                        "display": "number",
                    },
                ),
                "fps": (
                    "INT",
                    {
                        "default": 30,
                        "min": 1,
                        "max": 240,
                        "step": 1,
                        "display": "number",
                    },
                ),
                "crf": (
                    "INT",
                    {
                        "default": 18,
                        "min": 0,
                        "max": 51,
                        "step": 1,
                        "display": "number",
                    },
                ),
                "preset": (
                    [
                        "ultrafast",
                        "superfast",
                        "veryfast",
                        "faster",
                        "fast",
                        "medium",
                        "slow",
                        "slower",
                        "veryslow",
                    ],
                    {"default": "medium"},
                ),
            },
        }

    def combine_videos(
        self,
        video_1,
        video_2,
        mode,
        audio,
        duration,
        output_filename,
        width=0,
        height=0,
        fps=30,
        crf=18,
        preset="medium",
    ):
        ffmpeg = _find_executable("ffmpeg")
        ffprobe = _find_executable("ffprobe")

        first = _resolve_video_path(video_1)
        second = _resolve_video_path(video_2)
        output_path = _make_output_path(output_filename)

        first_info = _probe_video(ffprobe, first)
        second_info = _probe_video(ffprobe, second)

        if mode == "concatenate":
            command = _build_concat_command(
                ffmpeg=ffmpeg,
                first=first,
                second=second,
                output_path=output_path,
                first_info=first_info,
                second_info=second_info,
                width=width,
                height=height,
                fps=fps,
                crf=crf,
                preset=preset,
            )
        else:
            command = _build_stack_command(
                ffmpeg=ffmpeg,
                first=first,
                second=second,
                output_path=output_path,
                first_info=first_info,
                second_info=second_info,
                mode=mode,
                audio=audio,
                duration=duration,
                width=width,
                height=height,
                fps=fps,
                crf=crf,
                preset=preset,
            )

        _run(command)
        return (str(output_path),)


def _find_executable(name):
    executable = shutil.which(name)
    if executable:
        return executable

    raise ComfyVideoCombineError(
        f"Could not find {name}. Install FFmpeg and make sure '{name}' is on PATH."
    )


def _resolve_video_path(value):
    path_text = _extract_path_text(value).strip().strip("\"'")
    if not path_text:
        raise ComfyVideoCombineError("Video path is empty.")

    path = Path(path_text).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path

    path = path.resolve()
    if not path.exists():
        raise ComfyVideoCombineError(f"Video file does not exist: {path}")
    if not path.is_file():
        raise ComfyVideoCombineError(f"Video path is not a file: {path}")

    return path


def _extract_path_text(value):
    if isinstance(value, (str, Path)):
        return str(value)

    if isinstance(value, dict):
        for key in ("full_path", "path", "filename", "file"):
            if key in value:
                return _extract_path_text(value[key])
        for key in ("filenames", "files"):
            if key in value and value[key]:
                return _extract_path_text(value[key][0])

    if isinstance(value, (list, tuple)) and value:
        return _extract_path_text(value[0])

    return str(value)


def _make_output_path(output_filename):
    filename = output_filename.strip().strip("\"'") or "combined_video.mp4"
    filename = Path(filename).name
    filename = re.sub(r"[^A-Za-z0-9._ -]+", "_", filename).strip()

    if not filename:
        filename = "combined_video.mp4"
    if not Path(filename).suffix:
        filename = f"{filename}.mp4"

    stem = Path(filename).stem
    suffix = Path(filename).suffix or ".mp4"
    unique_filename = f"{stem}_{uuid.uuid4().hex[:8]}{suffix}"

    output_dir = _get_output_dir()
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir / unique_filename


def _get_output_dir():
    if folder_paths is not None:
        return Path(folder_paths.get_output_directory()).resolve()

    return (Path.cwd() / "output").resolve()


def _probe_video(ffprobe, video_path):
    command = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,width,height",
        "-of",
        "json",
        str(video_path),
    ]
    result = _run(command, capture=True)
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    video_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "video"),
        None,
    )

    if not video_stream:
        raise ComfyVideoCombineError(f"No video stream found in: {video_path}")

    return {
        "width": int(video_stream["width"]),
        "height": int(video_stream["height"]),
        "has_audio": any(stream.get("codec_type") == "audio" for stream in streams),
    }


def _build_concat_command(
    ffmpeg,
    first,
    second,
    output_path,
    first_info,
    second_info,
    width,
    height,
    fps,
    crf,
    preset,
):
    target_width = _even(width or first_info["width"])
    target_height = _even(height or first_info["height"])
    video_filter = (
        f"[0:v]{_fit_filter(target_width, target_height)},fps={fps},format=yuv420p[v0];"
        f"[1:v]{_fit_filter(target_width, target_height)},fps={fps},format=yuv420p[v1]"
    )

    command = [ffmpeg, "-y", "-i", str(first), "-i", str(second)]

    if first_info["has_audio"] and second_info["has_audio"]:
        filter_complex = (
            f"{video_filter};"
            "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];"
            "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];"
            "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"
        )
        command.extend(["-filter_complex", filter_complex, "-map", "[v]", "-map", "[a]"])
    else:
        filter_complex = f"{video_filter};[v0][v1]concat=n=2:v=1:a=0[v]"
        command.extend(["-filter_complex", filter_complex, "-map", "[v]", "-an"])

    command.extend(_encoding_args(crf, preset, output_path))
    return command


def _build_stack_command(
    ffmpeg,
    first,
    second,
    output_path,
    first_info,
    second_info,
    mode,
    audio,
    duration,
    width,
    height,
    fps,
    crf,
    preset,
):
    command = [ffmpeg, "-y", "-i", str(first), "-i", str(second)]
    shortest = 1 if duration == "shortest" else 0

    if mode == "side_by_side":
        target_height = _even(height or max(first_info["height"], second_info["height"]))
        stack_filter = (
            f"[0:v]scale=-2:{target_height},setsar=1,fps={fps}[v0];"
            f"[1:v]scale=-2:{target_height},setsar=1,fps={fps}[v1];"
            f"[v0][v1]hstack=inputs=2:shortest={shortest},format=yuv420p[v]"
        )
    else:
        target_width = _even(width or max(first_info["width"], second_info["width"]))
        stack_filter = (
            f"[0:v]scale={target_width}:-2,setsar=1,fps={fps}[v0];"
            f"[1:v]scale={target_width}:-2,setsar=1,fps={fps}[v1];"
            f"[v0][v1]vstack=inputs=2:shortest={shortest},format=yuv420p[v]"
        )

    filter_complex, audio_maps = _audio_filter_and_maps(
        stack_filter,
        first_info,
        second_info,
        audio,
    )
    command.extend(["-filter_complex", filter_complex, "-map", "[v]"])
    command.extend(audio_maps)
    command.extend(_encoding_args(crf, preset, output_path))
    return command


def _audio_filter_and_maps(video_filter, first_info, second_info, audio):
    if audio == "mix" and first_info["has_audio"] and second_info["has_audio"]:
        return (
            f"{video_filter};"
            "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];"
            "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];"
            "[a0][a1]amix=inputs=2:duration=longest:normalize=0[a]",
            ["-map", "[a]"],
        )

    if audio == "first" and first_info["has_audio"]:
        return video_filter, ["-map", "0:a:0?"]
    if audio == "second" and second_info["has_audio"]:
        return video_filter, ["-map", "1:a:0?"]
    if audio == "mix" and first_info["has_audio"]:
        return video_filter, ["-map", "0:a:0?"]
    if audio == "mix" and second_info["has_audio"]:
        return video_filter, ["-map", "1:a:0?"]

    return video_filter, ["-an"]


def _fit_filter(width, height):
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
        "setsar=1"
    )


def _encoding_args(crf, preset, output_path):
    return [
        "-c:v",
        "libx264",
        "-crf",
        str(crf),
        "-preset",
        preset,
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(output_path),
    ]


def _even(value):
    value = max(2, int(value))
    return value if value % 2 == 0 else value - 1


def _run(command, capture=False):
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise ComfyVideoCombineError(message)

    if capture:
        return result
    return None


NODE_CLASS_MAPPINGS = {
    "VideoCombinerFFmpeg": VideoCombinerFFmpeg,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoCombinerFFmpeg": "Combine Videos (FFmpeg)",
}
