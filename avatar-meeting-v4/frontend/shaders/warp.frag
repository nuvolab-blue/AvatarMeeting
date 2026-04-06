#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_mouthOpenness;
uniform vec2 u_mouthCenter;

out vec4 fragColor;

void main() {
    vec4 texColor = texture(u_texture, v_texCoord);

    if (u_mouthOpenness > 0.15) {
        float openness = u_mouthOpenness - 0.15;
        float mouthRadius = 0.03 * openness;
        vec2 diff = v_texCoord - u_mouthCenter;
        float ellipseDist = sqrt(diff.x * diff.x / (1.5 * 1.5) + diff.y * diff.y);
        float darkness = smoothstep(mouthRadius, mouthRadius * 0.5, ellipseDist);

        vec3 mouthInterior = vec3(0.08, 0.04, 0.03);
        vec3 teeth = vec3(0.85, 0.82, 0.78);
        float teethBand = smoothstep(
            u_mouthCenter.y - mouthRadius * 0.3,
            u_mouthCenter.y,
            v_texCoord.y
        );
        vec3 interior = mix(teeth, mouthInterior, teethBand);
        float blend = darkness * min(openness * 2.0, 1.0);
        vec3 finalColor = mix(interior, texColor.rgb, 1.0 - blend);
        fragColor = vec4(finalColor, 1.0);
    } else {
        fragColor = texColor;
    }
}
