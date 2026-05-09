from fractions import Fraction


try:
    from comfy_api.latest import InputImpl, Types
except ImportError:
    InputImpl = None
    Types = None


class ComfyVideoCombineError(RuntimeError):
    pass


PACK_NAME = "Media Pack"
VIDEO_CATEGORY = f"{PACK_NAME}/video"
AUDIO_CATEGORY = f"{PACK_NAME}/audio"
UTILS_CATEGORY = f"{PACK_NAME}/utils"


class VideoConcatenate:
    CATEGORY = VIDEO_CATEGORY
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "concatenate"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "overlap_seconds": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 3600.0,
                        "step": 0.01,
                        "display": "number",
                    },
                ),
            },
            "optional": {
                "video_1": ("VIDEO", {}),
                "video_2": ("VIDEO", {}),
            },
        }

    def concatenate(self, overlap_seconds, video_1=None, video_2=None):
        if video_1 is None and video_2 is None:
            raise ComfyVideoCombineError("Connect at least one video input.")
        if video_1 is None:
            return (video_2,)
        if video_2 is None:
            return (video_1,)

        if InputImpl is None or Types is None:
            raise ComfyVideoCombineError(
                "ComfyUI's native video API is not available. Update ComfyUI to a "
                "version with built-in VIDEO support."
            )

        first = video_1.get_components()
        second = video_2.get_components()

        if _is_empty_video(first):
            return (video_2,)
        if _is_empty_video(second):
            return (video_1,)

        first_images = _validate_images(_rgb_images(first.images), "video_1")
        second_images = _validate_images(_rgb_images(second.images), "video_2")
        second_images = _resize_to_match(second_images, first_images)
        second_trim_frames = _overlap_frame_count(
            overlap_seconds,
            first.frame_rate,
            second_images.shape[0],
        )
        second_images = second_images[second_trim_frames:]
        second_skip_seconds = second_trim_frames / float(_frame_rate(first.frame_rate))

        torch, _ = _torch_modules()
        images = torch.cat((first_images, second_images), dim=0)
        audio = _concatenate_audio(
            first.audio,
            second.audio,
            first.frame_rate,
            first_images.shape[0],
            second_images.shape[0],
            second_skip_seconds,
        )

        video = InputImpl.VideoFromComponents(
            Types.VideoComponents(
                images=images,
                audio=audio,
                frame_rate=_frame_rate(first.frame_rate),
            )
        )
        return (video,)


class VideoClipSeconds:
    CATEGORY = VIDEO_CATEGORY
    RETURN_TYPES = ("VIDEO", "IMAGE")
    RETURN_NAMES = ("video", "images")
    FUNCTION = "clip_video"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_video": ("VIDEO", {}),
                "seconds": (
                    "FLOAT",
                    {
                        "default": -1.0,
                        "min": -36000.0,
                        "max": 36000.0,
                        "step": 0.01,
                        "display": "number",
                    },
                ),
            },
        }

    def clip_video(self, source_video, seconds):
        if InputImpl is None or Types is None:
            raise ComfyVideoCombineError(
                "ComfyUI's native video API is not available. Update ComfyUI to a "
                "version with built-in VIDEO support."
            )

        components = source_video.get_components()
        images = _validate_images(_rgb_images(components.images), "source_video")
        start_frame, frame_count = _clip_frame_range(
            seconds,
            components.frame_rate,
            images.shape[0],
        )
        end_frame = start_frame + frame_count
        clipped_images = images[start_frame:end_frame]
        audio = _audio_for_frame_range(
            components.audio,
            components.frame_rate,
            start_frame,
            frame_count,
        )

        video = InputImpl.VideoFromComponents(
            Types.VideoComponents(
                images=clipped_images,
                audio=audio,
                frame_rate=_frame_rate(components.frame_rate),
            )
        )
        return (video, clipped_images)


class AudioSlice:
    CATEGORY = AUDIO_CATEGORY
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "slice_audio"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_audio": ("AUDIO", {}),
                "start": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 36000.0,
                        "step": 0.01,
                        "display": "number",
                    },
                ),
                "duration": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 36000.0,
                        "step": 0.01,
                        "display": "number",
                    },
                ),
            },
        }

    def slice_audio(self, source_audio, start, duration):
        waveform, sample_rate = _audio_parts(source_audio)
        if waveform is None:
            raise ComfyVideoCombineError("source_audio does not contain audio data.")

        total_samples = waveform.shape[-1]
        start_sample = min(total_samples, round(start * sample_rate))
        if start_sample >= total_samples:
            raise ComfyVideoCombineError("start is beyond the end of source_audio.")

        if duration <= 0:
            end_sample = total_samples
        else:
            end_sample = min(total_samples, start_sample + round(duration * sample_rate))

        if end_sample <= start_sample:
            raise ComfyVideoCombineError("duration is too short to produce audio.")

        return (
            {
                "waveform": waveform[..., start_sample:end_sample],
                "sample_rate": sample_rate,
            },
        )


class StringNumberListItem:
    CATEGORY = UTILS_CATEGORY
    RETURN_TYPES = ("STRING", "FLOAT")
    RETURN_NAMES = ("string", "number")
    FUNCTION = "select_item"
    ROW_COUNT = 20

    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {
                "index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": cls.ROW_COUNT - 1,
                        "step": 1,
                        "display": "number",
                    },
                ),
            },
        }

        for row_index in range(cls.ROW_COUNT):
            inputs["required"][f"row_{row_index}_string"] = (
                "STRING",
                {
                    "default": "",
                    "multiline": False,
                },
            )
            inputs["required"][f"row_{row_index}_number"] = (
                "FLOAT",
                {
                    "default": 0.0,
                    "min": -1000000000.0,
                    "max": 1000000000.0,
                    "step": 0.01,
                    "display": "number",
                },
            )

        return inputs

    def select_item(self, index, **kwargs):
        return (
            kwargs[f"row_{index}_string"],
            kwargs[f"row_{index}_number"],
        )


def _validate_images(images, input_name):
    if images.ndim != 4 or images.shape[0] == 0:
        raise ComfyVideoCombineError(f"{input_name} does not contain any video frames.")
    return images


def _is_empty_video(components):
    images = components.images
    return images.ndim != 4 or images.shape[0] == 0


def _rgb_images(images):
    if images.shape[-1] == 3:
        return images
    if images.shape[-1] > 3:
        return images[..., :3]
    if images.shape[-1] == 1:
        return images.repeat(1, 1, 1, 3)
    raise ComfyVideoCombineError("Video frames must have at least one image channel.")


def _resize_to_match(images, target_images):
    _, functional = _torch_modules()
    target_height = target_images.shape[1]
    target_width = target_images.shape[2]

    if images.shape[1] == target_height and images.shape[2] == target_width:
        return images

    channels_first = images.movedim(-1, 1)
    resized = functional.interpolate(
        channels_first,
        size=(target_height, target_width),
        mode="bilinear",
        align_corners=False,
    )
    return resized.movedim(1, -1)


def _overlap_frame_count(overlap_seconds, frame_rate, max_frames):
    if overlap_seconds <= 0:
        return 0

    fps = float(_frame_rate(frame_rate))
    return min(max_frames, round(overlap_seconds * fps))


def _clip_frame_range(seconds, frame_rate, max_frames):
    if seconds <= 0:
        if seconds == 0:
            return 0, max_frames

        frame_count = _seconds_to_frame_count(abs(seconds), frame_rate, max_frames)
        return max_frames - frame_count, frame_count

    frame_count = _seconds_to_frame_count(seconds, frame_rate, max_frames)
    return 0, frame_count


def _seconds_to_frame_count(seconds, frame_rate, max_frames):
    fps = float(_frame_rate(frame_rate))
    return max(1, min(max_frames, round(seconds * fps)))


def _audio_for_frame_range(audio, frame_rate, start_frame, frame_count):
    waveform, sample_rate = _audio_parts(audio)
    if waveform is None:
        return None

    start_sample = _samples_for_frames(start_frame, frame_rate, sample_rate)
    sample_count = _samples_for_frames(frame_count, frame_rate, sample_rate)
    return {
        "waveform": waveform[..., start_sample : start_sample + sample_count],
        "sample_rate": sample_rate,
    }


def _concatenate_audio(
    first_audio,
    second_audio,
    frame_rate,
    first_frames,
    second_frames,
    second_skip_seconds,
):
    torch, _ = _torch_modules()
    first_waveform, first_sample_rate = _audio_parts(first_audio)
    second_waveform, second_sample_rate = _audio_parts(second_audio)

    if first_waveform is None and second_waveform is None:
        return None

    sample_rate = first_sample_rate or second_sample_rate
    channels = _target_channels(first_waveform, second_waveform)
    first_samples = _samples_for_frames(first_frames, frame_rate, sample_rate)
    second_samples = _samples_for_frames(second_frames, frame_rate, sample_rate)

    first_segment = _fit_audio_segment(
        first_waveform,
        first_sample_rate,
        sample_rate,
        channels,
        first_samples,
    )
    second_segment = _fit_audio_segment(
        second_waveform,
        second_sample_rate,
        sample_rate,
        channels,
        second_samples,
        skip_seconds=second_skip_seconds,
    )

    return {
        "waveform": torch.cat((first_segment, second_segment), dim=-1),
        "sample_rate": sample_rate,
    }


def _audio_parts(audio):
    if not audio:
        return None, None

    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    return waveform, sample_rate


def _target_channels(first_waveform, second_waveform):
    if first_waveform is not None:
        return first_waveform.shape[1]
    return second_waveform.shape[1]


def _samples_for_frames(frame_count, frame_rate, sample_rate):
    fps = float(_frame_rate(frame_rate))
    return max(0, round((frame_count / fps) * sample_rate))


def _fit_audio_segment(
    waveform,
    source_rate,
    target_rate,
    channels,
    sample_count,
    skip_seconds=0.0,
):
    torch, functional = _torch_modules()
    if waveform is None:
        return torch.zeros((1, channels, sample_count), dtype=torch.float32)

    waveform = _resample_audio(waveform, source_rate, target_rate)
    waveform = _match_channels(waveform, channels)
    if skip_seconds > 0:
        skip_samples = round(skip_seconds * target_rate)
        waveform = waveform[..., skip_samples:]

    current_samples = waveform.shape[-1]
    if current_samples > sample_count:
        return waveform[..., :sample_count]
    if current_samples < sample_count:
        pad = sample_count - current_samples
        return functional.pad(waveform, (0, pad))
    return waveform


def _resample_audio(waveform, source_rate, target_rate):
    _, functional = _torch_modules()
    if source_rate == target_rate:
        return waveform

    target_samples = max(1, round(waveform.shape[-1] * target_rate / source_rate))
    return functional.interpolate(
        waveform,
        size=target_samples,
        mode="linear",
        align_corners=False,
    )


def _match_channels(waveform, channels):
    torch, _ = _torch_modules()
    current_channels = waveform.shape[1]
    if current_channels == channels:
        return waveform
    if current_channels == 1:
        return waveform.repeat(1, channels, 1)
    if channels == 1:
        return waveform.mean(dim=1, keepdim=True)
    if current_channels > channels:
        return waveform[:, :channels, :]

    padding = torch.zeros(
        (waveform.shape[0], channels - current_channels, waveform.shape[-1]),
        dtype=waveform.dtype,
        device=waveform.device,
    )
    return torch.cat((waveform, padding), dim=1)


def _frame_rate(frame_rate):
    if isinstance(frame_rate, Fraction):
        return frame_rate
    return Fraction(float(frame_rate)).limit_denominator()


def _torch_modules():
    try:
        import torch
        import torch.nn.functional as functional
    except ImportError as error:
        raise ComfyVideoCombineError(
            "Torch is required to concatenate native ComfyUI VIDEO inputs."
        ) from error

    return torch, functional


NODE_CLASS_MAPPINGS = {
    "AudioSlice": AudioSlice,
    "StringNumberListItem": StringNumberListItem,
    "VideoConcatenate": VideoConcatenate,
    "VideoClipSeconds": VideoClipSeconds,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AudioSlice": "Media Pack - Slice Audio",
    "StringNumberListItem": "Media Pack - String Number List Item",
    "VideoConcatenate": "Media Pack - Concatenate Videos",
    "VideoClipSeconds": "Media Pack - Video Clip Seconds",
}
