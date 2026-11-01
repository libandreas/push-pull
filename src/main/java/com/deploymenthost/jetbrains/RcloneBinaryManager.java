package com.deploymenthost.jetbrains;

import com.intellij.openapi.application.PathManager;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class RcloneBinaryManager {
    private static final Map<String, List<String>> SUPPORTED_PLATFORMS = Map.of(
        "windows", List.of("amd64", "386", "arm64"),
        "osx", List.of("amd64", "arm64"),
        "linux", List.of("amd64", "386", "arm64", "arm", "arm-v6", "arm-v7", "loong64", "ppc64", "ppc64le", "riscv64", "s390x", "mips", "mipsle", "mips64", "mips64le"),
        "freebsd", List.of("amd64", "386", "arm", "arm-v6", "arm-v7"),
        "openbsd", List.of("amd64", "386"),
        "netbsd", List.of("amd64", "386", "arm", "arm-v6", "arm-v7"),
        "solaris", List.of("amd64"),
        "aix", List.of("ppc64")
    );

    static synchronized Path ensureRcloneAvailable(Consumer<String> reportProgress)
        throws IOException, InterruptedException {
        String osName = System.getProperty("os.name").toLowerCase(Locale.ROOT);
        String platform;
        if (osName.contains("mac") || osName.contains("darwin")) {
            platform = "osx";
        } else if (osName.contains("win")) {
            platform = "windows";
        } else if (osName.contains("sunos") || osName.contains("solaris")) {
            platform = "solaris";
        } else {
            platform = osName;
        }
        String architecture = switch (System.getProperty("os.arch").toLowerCase(Locale.ROOT)) {
            case "x86_64", "amd64" -> "amd64";
            case "x86", "i386", "i486", "i586", "i686" -> "386";
            case "aarch64", "arm64" -> "arm64";
            case "armv6l" -> "arm-v6";
            case "armv7l" -> "arm-v7";
            case "mipsel", "mipsle" -> "mipsle";
            case "mips64el", "mips64le" -> "mips64le";
            case "loongarch64", "loong64" -> "loong64";
            default -> System.getProperty("os.arch").toLowerCase(Locale.ROOT);
        };
        if (!SUPPORTED_PLATFORMS.containsKey(platform) || !SUPPORTED_PLATFORMS.get(platform).contains(architecture)) {
            throw new IOException("No official rclone download mapping is configured for platform " + platform + " " + architecture + ".");
        }

        Path storageDirectory = Path.of(PathManager.getSystemPath(), "push-and-pull", "rclone");
        String binaryName = platform.equals("windows") ? "rclone.exe" : "rclone";
        Path executablePath = storageDirectory.resolve(binaryName);
        if (Files.exists(executablePath)) {
            validateRclone(executablePath);
            return executablePath;
        }

        Files.createDirectories(storageDirectory);
        Path temporaryPath = storageDirectory.resolve(platform.equals("windows") ? "rclone.new.exe" : "rclone.new");
        Path archivePath = storageDirectory.resolve("rclone.zip");
        URI downloadUri = URI.create("https://downloads.rclone.org/rclone-current-" + platform + "-" + architecture + ".zip");
        reportProgress.accept("Downloading rclone...");
        try (HttpClient client = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(30))
            .build()) {
            HttpRequest request = HttpRequest.newBuilder(downloadUri)
                .timeout(Duration.ofMinutes(5))
                .header("User-Agent", "push-and-pull-jetbrains-plugin")
                .GET()
                .build();
            HttpResponse<Path> response = client.send(request, HttpResponse.BodyHandlers.ofFile(archivePath));
            if (response.statusCode() != 200) {
                throw new IOException("rclone download failed with status " + response.statusCode() + ".");
            }

            reportProgress.accept("Extracting rclone...");
            boolean extracted = false;
            try (InputStream input = Files.newInputStream(archivePath); ZipInputStream archive = new ZipInputStream(input)) {
                ZipEntry entry;
                while ((entry = archive.getNextEntry()) != null) {
                    if (!entry.isDirectory() && binaryName.equals(Path.of(entry.getName()).getFileName().toString())) {
                        Files.copy(archive, temporaryPath, StandardCopyOption.REPLACE_EXISTING);
                        extracted = true;
                        break;
                    }
                }
            }
            if (!extracted) {
                throw new IOException("Could not find the rclone binary inside the downloaded archive.");
            }
            if (!platform.equals("windows")) {
                Files.setPosixFilePermissions(temporaryPath, PosixFilePermissions.fromString("rwxr-xr-x"));
            }
            validateRclone(temporaryPath);
            Files.move(temporaryPath, executablePath, StandardCopyOption.REPLACE_EXISTING);
            return executablePath;
        } finally {
            Files.deleteIfExists(temporaryPath);
            Files.deleteIfExists(archivePath);
        }
    }

    private static void validateRclone(Path executablePath) throws IOException, InterruptedException {
        Process process = new ProcessBuilder(executablePath.toString(), "version")
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .start();
        if (process.waitFor() != 0) {
            throw new IOException("Could not run rclone version: " + executablePath);
        }
    }
}
